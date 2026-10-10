import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ExitCode } from '../exitcode-core.mjs';
import { DEFAULT_STORE_DIR, MAX_TREE_BYTES, readJson } from '../exitcode-files.mjs';
import { invoke } from '../exitcode-runner.mjs';
import { workspace, manifest, driver, contract, ok } from './helpers.mjs';

async function configured(t, options = {}, source = driver) {
  const cwd = workspace(t), supervisor = new ExitCode(cwd, options);
  const id = ok(await supervisor.start('Finish the feature')).task;
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': source } }));
  const taskRoot = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id);
  return { cwd, supervisor, id, taskRoot };
}
function inspected(supervisor, runId) {
  const result = ok(supervisor.inspect('run', { runId }));
  assert.equal(result.inspection.runId, runId ?? supervisor.status().lastEvidenceId);
  return JSON.parse(result.inspection.text);
}
function patch(t, method, replace) {
  const original = fs[method];
  fs[method] = replace(original); syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; fs[method] = original; syncBuiltinESMExports(); } };
  t.after(restore);
  return restore;
}
function noWork(directory) {
  for (const name of ['candidate', 'project', 'home']) assert.ok(!fs.existsSync(path.join(directory, name)), name);
}
function noPreparing(cwd) {
  const root = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments');
  for (const environment of fs.readdirSync(root)) {
    assert.ok(!fs.readdirSync(path.join(root, environment)).some(name => name.startsWith('preparing-')));
  }
}

test('oversized prepared runtime retains accurate ERROR evidence, its ID and tree budget', async t => {
  const source = driver.replace("if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });",
    `if(request.operation==='prepare'){ const fd=fs.openSync(path.join(request.runtimeDirectory,'large.bin'),'w'); fs.ftruncateSync(fd,${MAX_TREE_BYTES + 1}); fs.closeSync(fd); reply({status:'OK'}); } else if(request.operation==='dispose')reply({status:'OK'});`);
  const { cwd, supervisor, taskRoot } = await configured(t, {}, source);
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'TREE_TOO_LARGE');
  assert.match(result.runId, /^E/);
  assert.equal(result.stage, 'runtime-capture');
  assert.match(result.message, /prepared runtime/);
  assert.doesNotMatch(result.message, /focused project workspace/);
  const evidence = inspected(supervisor);
  assert.equal(evidence.status, 'ERROR');
  assert.equal(evidence.id, result.runId);
  assert.equal(evidence.stage, 'runtime-capture');
  assert.deepEqual(evidence.diagnostics.tree, { kind: 'prepared runtime', directory: result.diagnostics.tree.directory,
    path: 'large.bin', observedBytes: MAX_TREE_BYTES + 1, maxBytes: MAX_TREE_BYTES });
  assert.match(evidence.diagnostics.tree.directory, /environments\/.*\/preparing-/);
  assert.equal(evidence.diagnostics.process.operation, 'prepare');
  assert.equal(evidence.diagnostics.process.exit, 0);
  assert.equal(supervisor.status().phase, 'DISCOVERY');
  assert.equal((await supervisor.approve()).code, 'NOT_READY');
  noWork(path.join(taskRoot, `environment-setup-${result.runId}`));
  noPreparing(cwd);
});

test('runtime finalization failure cannot leave setup PASS and the unchanged project can retry', async t => {
  const { cwd, supervisor, taskRoot } = await configured(t);
  const restore = patch(t, 'renameSync', original => (source, destination) => {
    if (source.startsWith(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments')) && path.basename(source).startsWith('preparing-')) {
      throw Object.assign(new Error('Injected runtime rename failure'), { code: 'EIO' });
    }
    return original(source, destination);
  });
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'EIO');
  assert.match(result.runId, /^E/);
  assert.equal(result.stage, 'runtime-finalize');
  assert.equal(inspected(supervisor).status, 'ERROR');
  const setup = path.join(taskRoot, `environment-setup-${result.runId}`);
  assert.equal(readJson(path.join(setup, 'result.json')).status, 'ERROR');
  noWork(setup); noPreparing(cwd);
  restore();
  const prepared = ok(await supervisor.draft(contract()));
  assert.equal(prepared.phase, 'READY');
  assert.equal(prepared.preparation.warmEnvironment, false);
  assert.equal(inspected(supervisor, result.runId).status, 'ERROR');
  assert.equal(inspected(supervisor).id, prepared.preparation.id);
});

test('setup copy mismatch is attributable, inspectable and cleaned before any driver runs', async t => {
  const calls = [], { cwd, supervisor, taskRoot } = await configured(t, { runner: async (...args) => { calls.push(args[1].operation); return invoke(...args); } });
  patch(t, 'copyFileSync', original => (source, destination, ...args) => {
    original(source, destination, ...args);
    if (destination.startsWith(taskRoot) && destination.includes('/environment-setup-') && destination.endsWith('/candidate/feature.txt')) {
      fs.writeFileSync(destination, 'changed\n');
    }
  });
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'CANDIDATE_CHANGED');
  assert.match(result.runId, /^E/);
  assert.equal(result.stage, 'candidate-copy');
  assert.deepEqual(calls, []);
  const evidence = inspected(supervisor);
  assert.equal(evidence.status, 'ERROR');
  assert.equal(evidence.diagnostics.capture.comparison, 'source/copy');
  assert.equal(evidence.diagnostics.capture.totalDifferences, 1);
  assert.equal(evidence.diagnostics.capture.differences[0].path, 'feature.txt');
  assert.deepEqual(evidence.diagnostics.capture.differences[0].fields, ['sha']);
  assert.match(result.message, /feature\.txt/);
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'pending\n');
  noWork(path.join(taskRoot, `environment-setup-${result.runId}`)); noPreparing(cwd);
});

test('trial copy failure retains earlier results and the failed trial; default inspection selects new ERROR', async t => {
  const calls = [], { cwd, supervisor, taskRoot } = await configured(t, { runner: async (...args) => { calls.push(args[1].operation); return invoke(...args); } });
  const spec = contract(); spec.scenarios[0].trials = 2;
  ok(await supervisor.draft(spec)); ok(await supervisor.approve());
  const previous = ok(await supervisor.evaluate()).run;
  assert.equal(previous.status, 'FAIL');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  calls.length = 0;
  patch(t, 'copyFileSync', original => (source, destination, ...args) => {
    original(source, destination, ...args);
    if (destination.startsWith(taskRoot) && destination.endsWith('/feature-2/candidate/feature.txt')) fs.writeFileSync(destination, 'nope\n');
  });
  const result = await supervisor.evaluate();
  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 'CANDIDATE_CHANGED');
  assert.match(result.runId, /^R/);
  assert.equal(result.stage, 'candidate-copy');
  assert.equal(result.scenario, 'feature'); assert.equal(result.trial, 2);
  const run = inspected(supervisor);
  assert.equal(run.id, result.runId);
  assert.equal(run.status, 'ERROR');
  assert.deepEqual(run.results.map(trial => trial.status), ['PASS', 'ERROR']);
  assert.equal(run.results[1].scenario, 'feature'); assert.equal(run.results[1].trial, 2);
  assert.equal(run.results[1].diagnostics.capture.differences[0].path, 'feature.txt');
  assert.deepEqual(calls, ['run', 'dispose'], 'Do not invoke a driver on an incomplete copy');
  const failed = path.join(taskRoot, 'runs', result.runId, 'feature-2');
  assert.equal(readJson(path.join(failed, 'result.json')).status, 'ERROR');
  noWork(failed);
  assert.equal(inspected(supervisor, previous.id).status, 'FAIL');
  assert.equal(supervisor.status().phase, 'SEALED');
  assert.equal(supervisor.status().runCount, 2);
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'done\n');
  // A later non-evaluation issue must not hide the newest retained failure.
  assert.equal((await supervisor.configure({ manifest, files: { 'driver.mjs': driver } })).code, 'SEALED');
  assert.equal(inspected(supervisor).id, result.runId);
});

test('invalid driver reply retains bounded stdout, stderr and exit status through normal inspection', async t => {
  const source = `let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);
    console.error('driver diagnostic');
    console.log(JSON.stringify(r.operation==='dispose'?{protocol:1,status:'OK'}:{protocol:1,status:'ready',ok:true,observations:{long:'x'.repeat(10000)}}));`;
  const { supervisor } = await configured(t, {}, source);
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'INVALID_REPORT');
  assert.match(result.runId, /^E/);
  assert.match(result.message, /OK, UNAVAILABLE, ERROR/);
  assert.match(result.message, /unknown.*ok/i);
  const evidence = inspected(supervisor), process = evidence.diagnostics.process;
  assert.equal(evidence.status, 'ERROR');
  assert.equal(process.operation, 'prepare');
  assert.equal(process.exit, 0);
  assert.equal(process.termSignal, null);
  assert.equal(process.stderr, 'driver diagnostic\n');
  assert.ok(process.stdout.length <= 2000);
  assert.equal(process.stdoutTruncated, true);
  assert.equal(process.stderrTruncated, false);
});

test('inspection distinguishes absent evidence from an invalid explicit ID', async t => {
  const { supervisor } = await configured(t);
  assert.equal(supervisor.inspect('run').code, 'NO_EVIDENCE');
  assert.equal(supervisor.inspect('run', { runId: 'invalid' }).code, 'INVALID_ID');
  assert.equal(supervisor.inspect('run', { runId: 'R00000000-0000-0000-0000-000000000000' }).code, 'INVALID_ID');
});

test('prepared environment drift retains new ERROR evidence instead of selecting an old acceptance', async t => {
  const { cwd, supervisor } = await configured(t);
  ok(await supervisor.draft(contract())); ok(await supervisor.approve());
  const previous = ok(await supervisor.evaluate()).run;
  const environments = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments');
  const environment = path.join(environments, fs.readdirSync(environments)[0]);
  const identity = readJson(path.join(environment, 'identity.json'));
  fs.writeFileSync(path.join(environment, 'versions', identity.digest, 'drift'), 'changed');
  const result = await supervisor.evaluate();
  assert.equal(result.code, 'ENVIRONMENT_CHANGED');
  assert.match(result.runId, /^R/);
  assert.equal(result.stage, 'environment-check');
  assert.notEqual(result.runId, previous.id);
  assert.equal(inspected(supervisor).status, 'ERROR');
  assert.equal(inspected(supervisor, previous.id).status, 'FAIL');
  assert.equal(supervisor.status().phase, 'SEALED');
});

test('trial capture I/O errors retain the failed stage and clean partially copied work', async t => {
  const { cwd, supervisor, taskRoot } = await configured(t);
  ok(await supervisor.draft(contract())); ok(await supervisor.approve());
  patch(t, 'copyFileSync', original => (source, destination, ...args) => {
    if (destination.startsWith(taskRoot) && destination.includes('/runs/') && destination.endsWith('/candidate/feature.txt')) {
      throw Object.assign(new Error('Injected copy I/O failure'), { code: 'EIO' });
    }
    return original(source, destination, ...args);
  });
  const result = await supervisor.evaluate();
  assert.equal(result.code, 'EIO');
  assert.equal(result.stage, 'candidate-copy');
  const run = inspected(supervisor);
  assert.deepEqual(run.results.map(trial => trial.status), ['ERROR']);
  assert.equal(run.results[0].trial, 1);
  noWork(path.join(taskRoot, 'runs', result.runId, 'feature-1'));
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'pending\n');
});

test('runtime-check failure preserves observed assertions without promoting them to acceptance PASS', async t => {
  const { cwd, supervisor } = await configured(t);
  ok(await supervisor.draft(contract())); ok(await supervisor.approve());
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  const racing = new ExitCode(cwd, { runner: async (...args) => {
    const result = await invoke(...args);
    if (args[1].operation === 'dispose') fs.writeFileSync(path.join(args[1].runtimeDirectory, 'changed'), 'drift');
    return result;
  } });
  const result = await racing.evaluate();
  assert.equal(result.code, 'ENVIRONMENT_CHANGED');
  assert.equal(result.stage, 'runtime-check');
  const run = inspected(racing), trial = run.results[0];
  assert.equal(run.status, 'ERROR');
  assert.equal(trial.status, 'ERROR');
  assert.ok(trial.assertions.every(assertion => assertion.status === 'PASS'));
  assert.equal(trial.observations.content, 'done\n');
  assert.equal(racing.status().phase, 'SEALED');
});

test('cancellation during setup cleanup invalidates preparation and retains its E record', async t => {
  const controller = new AbortController();
  const { cwd, supervisor, taskRoot } = await configured(t, { signal: controller.signal, runner: async (...args) => {
    const result = await invoke(...args);
    if (args[1].operation === 'dispose') controller.abort();
    return result;
  } });
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'CANCELLED');
  assert.match(result.runId, /^E/);
  assert.equal(inspected(supervisor).status, 'ERROR');
  assert.equal(supervisor.status().phase, 'DISCOVERY');
  noWork(path.join(taskRoot, `environment-setup-${result.runId}`)); noPreparing(cwd);
});

test('log persistence failure keeps the process diagnostic and its inspectable error record', async t => {
  const { supervisor, taskRoot } = await configured(t);
  patch(t, 'writeFileSync', original => (file, ...args) => {
    if (file.startsWith(taskRoot) && file.endsWith('prepare.stdout')) throw Object.assign(new Error('Injected log write failure'), { code: 'EIO' });
    return original(file, ...args);
  });
  const result = await supervisor.draft(contract());
  assert.equal(result.code, 'EIO');
  assert.match(result.runId, /^E/);
  const evidence = inspected(supervisor);
  assert.equal(evidence.status, 'ERROR');
  assert.equal(evidence.diagnostics.process.exit, 0);
  assert.equal(evidence.diagnostics.process.operation, 'prepare');
  assert.equal(evidence.diagnostics.logging.code, 'EIO');
  noWork(path.join(taskRoot, `environment-setup-${result.runId}`));
});
