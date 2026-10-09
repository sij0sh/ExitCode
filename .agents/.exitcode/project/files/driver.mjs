import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const request = JSON.parse(stdin);
const reply = value => console.log(JSON.stringify({ protocol: 1, ...value }));
const observed = path.join(request.runDirectory, 'observed');
const reference = path.join(request.runtimeDirectory, 'reference');
const required = ['exitcode.ts', 'exitcode-core.mjs', 'exitcode-files.mjs', 'exitcode-runner.mjs', 'exitcode-spec.mjs', 'exitcode-config.mjs'];
const hasProduct = () => required.every(name => fs.existsSync(path.join(request.candidateDirectory, name)));
const copy = (source, destination) => fs.cpSync(source, destination, { recursive: true });
const record = (name, data) => {
  fs.mkdirSync(path.join(request.runDirectory, 'artifacts'), { recursive: true });
  const relative = `artifacts/${name}`;
  fs.writeFileSync(path.join(request.runDirectory, relative), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return relative;
};
function hash(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), sha = createHash('sha256');
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) sha.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return sha.digest('hex');
}
function sizedFile(root, name, bytes, mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', mode);
  try {
    fs.ftruncateSync(fd, bytes);
    for (const offset of [0, Math.floor(bytes / 2), bytes - 1]) fs.writeSync(fd, Buffer.from([0x61]), 0, 1, offset);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(file, mode);
  return { path: name, bytes, mode, sha: hash(file) };
}
function textFile(root, name, content, mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode }); fs.chmodSync(file, mode);
  return { path: name, bytes: Buffer.byteLength(content), mode, sha: hash(file) };
}
function mutateByte(file, offset, value) {
  const fd = fs.openSync(file, 'r+'), previous = Buffer.alloc(1);
  try { fs.readSync(fd, previous, 0, 1, offset); fs.writeSync(fd, Buffer.from([value]), 0, 1, offset); }
  finally { fs.closeSync(fd); }
  return previous[0];
}
function setupObserved() {
  fs.mkdirSync(observed, { recursive: true });
  for (const name of fs.readdirSync(request.candidateDirectory)) {
    if (/\.(mjs|ts)$/.test(name) || name === 'package.json') fs.copyFileSync(path.join(request.candidateDirectory, name), path.join(observed, name));
  }
  for (const name of ['test', 'examples', 'scripts-check.mjs']) copy(path.join(reference, name), path.join(observed, name));
}
async function lifecycle(input) {
  const { harness } = await import(pathToFileURL(path.join(observed, 'test', 'adapter-helpers.mjs')).href);
  const { ExitCode } = await import(pathToFileURL(path.join(observed, 'exitcode-core.mjs')).href);
  const cleanups = [], h = await harness({ after: cleanup => cleanups.push(cleanup) });
  const measurements = { logicalBytes: 0, started: false, preparedPhase: null, baselineStatus: null, emptyStatus: null,
    approvedPhase: null, unresolvedStatus: null, finalStatus: null, preparedInputsComplete: false, finalInputsComplete: false,
    canonicalIsolation: false, freshPass: false, artifactEditInvalidates: false, sourceEditInvalidates: false, warnings: [] };
  try {
    await h.start();
    const files = [textFile(h.cwd, '.gitignore', '/target\n/BUILD/\n.agents/\n'),
      textFile(h.cwd, 'Cargo.toml', '[package]\nname="snapshot-fixture"\nversion="0.1.0"\nedition="2021"\n'),
      textFile(h.cwd, 'Cargo.lock', '# Retained lockfile\nversion = 4\n'),
      textFile(h.cwd, 'src/lib.rs', 'pub fn retained() -> bool { true }\n'),
      textFile(h.cwd, 'scripts/probe.sh', '#!/bin/sh\nexit 0\n', 0o755),
      sizedFile(h.cwd, 'src/retained-input.bin', input.otherBytes),
      sizedFile(h.cwd, 'BUILD/retained.bin', input.buildBytes),
      sizedFile(h.cwd, '.agents/recall.db', input.agentBytes)];
    let remaining = input.targetBytes, index = 0;
    while (remaining > 0) { const bytes = Math.min(remaining, input.chunkBytes); files.push(sizedFile(h.cwd, `target/debug/artifact-${index++}.bin`, bytes)); remaining -= bytes; }
    fs.symlinkSync('target/debug/artifact-0.bin', path.join(h.cwd, 'artifact-link'));
    fs.mkdirSync(path.join(h.cwd, '.git')); const git = fs.openSync(path.join(h.cwd, '.git', 'excluded.bin'), 'w'); fs.ftruncateSync(git, 600 * 1024 * 1024); fs.closeSync(git);
    measurements.logicalBytes = files.reduce((sum, file) => sum + file.bytes, fs.statSync(path.join(h.cwd, 'feature.txt')).size);
    await h.command('The fixture feature is pending in this built Rust workspace.');
    const owner = [...h.entries].reverse().find(entry => entry.customType === 'exitcode-scenarios' && entry.data.enabled);
    measurements.started = Boolean(owner);
    if (!owner) { measurements.warnings = h.notices.map(notice => notice.text); return measurements; }
    const observer = fs.readFileSync(path.join(request.projectDirectory, 'snapshot-observer.mjs'), 'utf8');
    const configured = (await h.call('exitcode_project', { manifest: { protocol: 1, name: 'Snapshot fixture observer', command: { program: 'node', args: ['observer.mjs'] }, timeoutSeconds: 300, environment: [], isolation: 'workspace' }, files: { 'observer.mjs': observer } })).details;
    if (!configured.ok) { measurements.warnings.push(`${configured.code}: ${configured.message}`); return measurements; }
    const spec = { version: 1, problem: 'The fixture feature remains pending.', happyPath: [{ id: 'feature', claim: 'The feature contains done and validation observes the retained project inputs.' }], constraints: [], scenarios: [{ id: 'feature', covers: ['feature'], description: 'Observe the feature and captured project inputs.', instructions: 'Read the feature, hash the named files, observe the link and excluded metadata, then modify only disposable source and artifact copies.', input: { fileNames: files.map(file => file.path), link: 'artifact-link', mutationFile: 'target/debug/artifact-0.bin' }, baseline: 'FAIL', trials: 1, timeoutSeconds: 300, assertions: [{ path: '/content', op: 'eq', value: 'done\n' }, { path: '/files', op: 'eq', value: files }, { path: '/linkTarget', op: 'eq', value: 'target/debug/artifact-0.bin' }, { path: '/gitIncluded', op: 'eq', value: false }, { path: '/storeIncluded', op: 'eq', value: false }, { path: '/mutatedCopies', op: 'eq', value: true }] }] };
    const prepared = (await h.call('exitcode_contract', spec)).details;
    measurements.preparedPhase = prepared.phase ?? null;
    measurements.baselineStatus = prepared.preparation?.results[0]?.status ?? null;
    measurements.emptyStatus = prepared.preparation?.results.find(trial => trial.wiring)?.status ?? null;
    measurements.preparedInputsComplete = prepared.preparation?.results[0]?.observations?.files && JSON.stringify(prepared.preparation.results[0].observations.files) === JSON.stringify(files) || false;
    if (!prepared.ok) { measurements.warnings.push(`${prepared.code}: ${prepared.message}`); return measurements; }
    await h.command('approve');
    const supervisor = new ExitCode(h.cwd);
    measurements.approvedPhase = supervisor.status(owner.data.taskId).phase ?? null;
    const unresolved = (await h.call('exitcode_evaluate')).details;
    measurements.unresolvedStatus = unresolved.status;
    if (!unresolved.ok) { measurements.warnings.push(`${unresolved.code}: ${unresolved.message}`); return measurements; }
    fs.writeFileSync(path.join(h.cwd, 'feature.txt'), 'done\n');
    const final = (await h.call('exitcode_evaluate')).details;
    measurements.finalStatus = final.status;
    measurements.finalInputsComplete = final.run?.results[0]?.observations?.files && JSON.stringify(final.run.results[0].observations.files) === JSON.stringify(files) || false;
    const originalSource = files.find(file => file.path === 'src/lib.rs'), originalArtifact = files.find(file => file.path === 'target/debug/artifact-0.bin');
    measurements.canonicalIsolation = hash(path.join(h.cwd, originalSource.path)) === originalSource.sha && hash(path.join(h.cwd, originalArtifact.path)) === originalArtifact.sha;
    measurements.freshPass = supervisor.freshPass(owner.data.taskId);
    const artifact = path.join(h.cwd, originalArtifact.path), offset = Math.floor(originalArtifact.bytes / 2) + 17;
    const old = mutateByte(artifact, offset, 0x78);
    measurements.artifactEditInvalidates = !supervisor.freshPass(owner.data.taskId);
    mutateByte(artifact, offset, old);
    fs.appendFileSync(path.join(h.cwd, 'src/lib.rs'), '// later edit\n');
    measurements.sourceEditInvalidates = !supervisor.freshPass(owner.data.taskId);
    measurements.warnings.push(...h.notices.filter(notice => notice.kind !== 'info').map(notice => notice.text));
    return measurements;
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}
async function boundaries() {
  const product = await import(pathToFileURL(path.join(observed, 'exitcode-files.mjs')).href);
  const root = path.join(request.runDirectory, 'fixture'), destination = path.join(request.runDirectory, 'copied'), storeDir = '.cache/validation';
  fs.mkdirSync(root, { recursive: true });
  const files = [textFile(root, '.gitignore', 'target/\n.agents/\n'), textFile(root, 'src/main.txt', 'retained source\n'),
    sizedFile(root, 'target/ignored.bin', 8192), textFile(root, 'script.sh', '#!/bin/sh\n', 0o755),
    textFile(root, '.agents/product.txt', 'retained sibling\n'), textFile(root, '.agents/.exitcode/product.txt', 'not the selected store\n')];
  fs.symlinkSync('src/main.txt', path.join(root, 'link'));
  for (const name of ['.git/hidden', `${storeDir}/state/hidden`]) sizedFile(root, name, 2 * 1024 * 1024);
  const options = { candidate: true, storeDir }, original = product.treeDigest(root, options);
  product.copyTree(root, destination, options);
  const measurements = { complete: files.every(file => fs.existsSync(path.join(destination, file.path)) && hash(path.join(destination, file.path)) === file.sha),
    excludedOnlyMetadata: !fs.existsSync(path.join(destination, '.git')) && !fs.existsSync(path.join(destination, storeDir)),
    modesAndLinks: fs.statSync(path.join(destination, 'script.sh')).mode % 512 === 0o755 && fs.readlinkSync(path.join(destination, 'link')) === 'src/main.txt',
    identityMatches: product.treeDigest(destination) === original, independent: false, interiorEditChangesIdentity: false,
    budgetCode: null, noPartialCopy: false, outsideAliasCode: null, privateAliasCode: null, cancelledCode: null };
  fs.writeFileSync(path.join(destination, 'src/main.txt'), 'copy edit'); mutateByte(path.join(destination, 'target/ignored.bin'), 4000, 0x78);
  measurements.independent = product.treeDigest(root, options) === original;
  mutateByte(path.join(root, 'target/ignored.bin'), 4000, 0x78); measurements.interiorEditChangesIdentity = product.treeDigest(root, options) !== original;
  const code = work => { try { work(); return null; } catch (error) { return error.code ?? error.name; } };
  const rejected = path.join(request.runDirectory, 'rejected');
  measurements.budgetCode = code(() => product.copyTree(root, rejected, { ...options, maxBytes: 1024 }));
  measurements.noPartialCopy = !fs.existsSync(rejected);
  const outside = path.join(request.runDirectory, 'outside.txt'); fs.writeFileSync(outside, 'outside'); fs.symlinkSync(outside, path.join(root, 'alias'));
  measurements.outsideAliasCode = code(() => product.inventory(root, options)); fs.unlinkSync(path.join(root, 'alias'));
  fs.symlinkSync(path.join(root, storeDir, 'state'), path.join(root, 'alias')); measurements.privateAliasCode = code(() => product.inventory(root, options)); fs.unlinkSync(path.join(root, 'alias'));
  const cancellation = new AbortController(); cancellation.abort(); measurements.cancelledCode = code(() => product.inventory(root, { ...options, signal: cancellation.signal }));
  return measurements;
}
function regressions() {
  const tests = fs.readdirSync(path.join(observed, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('test', name));
  const test = spawnSync(process.execPath, ['--test', ...tests], { cwd: observed, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const syntax = spawnSync(process.execPath, ['scripts-check.mjs'], { cwd: observed, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const output = (test.stdout ?? '') + (test.stderr ?? '');
  return { observations: { testExitCode: test.status, syntaxExitCode: syntax.status, passed: Number(output.match(/(?:# |ℹ )pass (\d+)/)?.[1] ?? -1), failed: Number(output.match(/(?:# |ℹ )fail (\d+)/)?.[1] ?? -1) },
    artifacts: [record('tests.log', output), record('syntax.log', (syntax.stdout ?? '') + (syntax.stderr ?? ''))] };
}
async function run() {
  if (request.operation === 'dispose') {
    for (const name of ['observed', 'fixture', 'copied', 'rejected', 'outside.txt']) fs.rmSync(path.join(request.runDirectory, name), { recursive: true, force: true });
    return { status: 'OK' };
  }
  if (request.operation === 'prepare') {
    if (!hasProduct()) throw new Error('ExitCode product is absent during environment preparation');
    fs.mkdirSync(reference, { recursive: true });
    copy(path.join(request.candidateDirectory, 'test'), path.join(reference, 'test'));
    fs.copyFileSync(path.join(request.candidateDirectory, 'scripts-check.mjs'), path.join(reference, 'scripts-check.mjs'));
    for (const example of ['file-project', 'pi-extension']) for (const name of ['driver.mjs', 'manifest.json', 'contract.json']) {
      const destination = path.join(reference, 'examples', example, name); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(request.candidateDirectory, 'examples', example, name), destination);
    }
    return { status: 'OK' };
  }
  if (!hasProduct()) return { status: 'UNAVAILABLE', reason: 'Candidate ExitCode modules are absent' };
  setupObserved();
  if (request.scenario.input.kind === 'regressions') return { status: 'OK', ...regressions() };
  const observations = request.scenario.input.kind === 'boundaries' ? await boundaries() : await lifecycle(request.scenario.input);
  observations.peakRssMiB = process.resourceUsage().maxRSS / 1024;
  return { status: 'OK', observations, artifacts: [record(`${request.scenario.id}.json`, observations)] };
}
try { reply(await run()); } catch (error) { reply({ status: 'ERROR', reason: `${error.code ?? error.name}: ${error.message}\n${error.stack}` }); }
