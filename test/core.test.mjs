import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExitCode, review } from '../exitcode-core.mjs';
import { readJson, writeJson, digest, locked, treeDigest, DEFAULT_STORE_DIR } from '../exitcode-files.mjs';
import { ready, workspace, driver, manifest, contract, ok } from './helpers.mjs';

test('problem-first lifecycle reproduces failure, freezes acceptance, and requires fresh real success', async t => {
  const { cwd, supervisor, id, prepared } = await ready(t);
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'pending\n');
  assert.equal(prepared.phase, 'READY');
  assert.match(prepared.review, /Happy path claims:\n  H1: The feature file contains done/);
  assert.match(prepared.review, /Scenario feature:[^\n]*\nCovers: H1\n/);
  assert.equal(prepared.preparation.results[0].status, 'FAIL');
  assert.equal(prepared.preparation.results[1].status, 'UNAVAILABLE');
  assert.equal((await supervisor.evaluate()).code, 'NOT_SEALED');
  ok(await supervisor.approve());
  assert.deepEqual(JSON.parse(supervisor.inspect('contract').inspection.text), contract());
  assert.equal((await supervisor.draft(contract())).code, 'SEALED');
  assert.equal((await supervisor.configure({ manifest, files: { 'driver.mjs': driver } })).code, 'SEALED');
  const failing = ok(await supervisor.evaluate());
  assert.equal(failing.status, 'FAIL');
  assert.equal(supervisor.status().phase, 'SEALED');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  // A live project change does not replace the sealed observer.
  fs.writeFileSync(path.join(cwd, DEFAULT_STORE_DIR, 'project', 'files', 'driver.mjs'), 'throw Error("changed live driver");');
  const passing = ok(await supervisor.evaluate());
  assert.equal(passing.status, 'PASS');
  assert.equal(passing.run.warmEnvironment, true);
  assert.notEqual(passing.run.id, failing.run.id);
  assert.ok(supervisor.freshPass(id));
  assert.equal(supervisor.status(id).active, false);
  const runRoot = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'runs', passing.run.id, 'feature-1');
  assert.equal(fs.readFileSync(path.join(runRoot, passing.run.results[0].artifacts[0].path), 'utf8'), 'done\n');
  assert.ok(!fs.existsSync(path.join(runRoot, 'candidate')));
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'a later edit');
  assert.equal(supervisor.freshPass(id), false);
});

test('approval review shows every claim and many-to-many scenario coverage, including unmapped guardrails', () => {
  const spec = contract();
  spec.happyPath.push({ id: 'H2', claim: 'Existing behavior remains valid' });
  spec.scenarios[0].covers.push('H2');
  spec.scenarios.push({ ...structuredClone(spec.scenarios[0]), id: 'existing', baseline: 'PASS', covers: ['H2'] },
    { ...structuredClone(spec.scenarios[0]), id: 'guardrail', baseline: 'PASS', covers: [] });
  const text = review({ problem: spec.problem, prepared: { contract: spec, project: { manifest }, run: { id: 'Rfixture', warmEnvironment: true }, digest: 'fixture' } });
  assert.match(text, /H1: The feature file contains done/);
  assert.match(text, /H2: Existing behavior remains valid/);
  assert.match(text, /Scenario feature:[^\n]*\nCovers: H1, H2\n/);
  assert.match(text, /Scenario existing:[^\n]*\nCovers: H2\n/);
  assert.match(text, /Scenario guardrail:[^\n]*\nCovers: none\n/);
  assert.match(text, /Coverage is declared/);
});

test('invalid coverage fails before driver preparation or approval', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd, { runner: async () => assert.fail('Invalid contracts must not execute a driver') });
  const id = ok(await supervisor.start('Finish feature')).task;
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': driver } }));
  for (const covers of [undefined, [], ['H1', 'unknown']]) {
    const spec = contract(); spec.scenarios[0].covers = covers;
    const result = await supervisor.draft(spec);
    assert.equal(result.code, 'INVALID_SPEC');
    assert.equal(result.runId, undefined);
    assert.equal(supervisor.status().phase, 'DISCOVERY');
  }
  assert.ok(!fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments')));
  assert.ok(!fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'runs')));
  assert.equal((await supervisor.approve()).code, 'NOT_READY');
});

test('persisted prose happy paths cannot bypass claim validation at approval or evaluation', async t => {
  for (const phase of ['READY', 'SEALED']) {
    const { cwd, supervisor, id } = await ready(t);
    if (phase === 'SEALED') ok(await supervisor.approve());
    const taskFile = supervisor.taskFile(id), task = readJson(taskFile);
    const legacy = contract(); legacy.happyPath = legacy.happyPath[0].claim;
    for (const scenario of legacy.scenarios) delete scenario.covers;
    task.contract = legacy;
    const sealed = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'sealed.json');
    if (phase === 'READY') {
      task.prepared.contract = legacy;
      task.prepared.digest = digest({ contract: legacy, project: task.prepared.project, candidateDigest: task.prepared.run.candidateDigest, environment: task.prepared.run.environment });
    } else {
      const bundle = readJson(sealed); bundle.contract = legacy;
      fs.chmodSync(sealed, 0o600); writeJson(sealed, bundle);
      task.sealedDigest = digest(bundle); // Simulate a seal produced by the previous schema, not damaged bytes.
    }
    writeJson(taskFile, task);
    const restored = new ExitCode(cwd, { runner: async () => assert.fail('Legacy contracts must not execute a driver') });
    const result = phase === 'READY' ? await restored.approve() : await restored.evaluate();
    assert.equal(result.code, 'INVALID_SPEC');
    assert.equal(restored.status().phase, phase);
    assert.equal(restored.status().runCount, 0);
    assert.deepEqual(readJson(taskFile).contract, legacy);
    if (phase === 'READY') {
      assert.ok(!fs.existsSync(sealed));
      ok(await supervisor.resume(id));
      ok(await supervisor.draft(contract()));
      ok(await supervisor.approve());
    } else assert.equal((await restored.resume(id)).code, 'INVALID_SPEC');
  }
});

test('pre-approval edits are preserved, invalidate review, and require explicit adoption', async t => {
  const { cwd, supervisor, id } = await ready(t);
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'still pending but changed\n');
  assert.equal((await supervisor.approve()).code, 'CANDIDATE_CHANGED');
  assert.equal(supervisor.status().phase, 'DISCOVERY');
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'still pending but changed\n');
  assert.equal((await supervisor.draft(contract())).code, 'CANDIDATE_CHANGED');
  ok(await supervisor.resume(id));
  ok(await supervisor.draft(contract()));
  ok(await supervisor.approve());
});

test('project drift during review requires new preparation', async t => {
  const { cwd, supervisor } = await ready(t);
  fs.appendFileSync(path.join(cwd, DEFAULT_STORE_DIR, 'project', 'files', 'driver.mjs'), '\n// newer observer\n');
  assert.equal((await supervisor.approve()).code, 'STALE_PREPARATION');
  ok(await supervisor.draft(contract()));
  ok(await supervisor.approve());
});

test('sealed-byte and evaluator-runtime tampering never produce passing evidence', async t => {
  const { cwd, supervisor, id } = await ready(t);
  ok(await supervisor.approve());
  const sealed = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'sealed.json');
  const original = fs.readFileSync(sealed, 'utf8');
  for (const change of [
    bundle => { bundle.contract.scenarios[0].assertions[0].value = 'pending\n'; },
    bundle => { bundle.contract.happyPath[0].claim = 'A different outcome'; },
    bundle => { bundle.contract.scenarios[0].covers = []; },
  ]) {
    const modified = JSON.parse(original); change(modified);
    fs.chmodSync(sealed, 0o600); fs.writeFileSync(sealed, JSON.stringify(modified));
    assert.equal((await supervisor.evaluate()).code, 'SEALED_CHANGED');
  }
  fs.writeFileSync(sealed, original);
  const environments = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments');
  const environment = fs.readdirSync(environments)[0];
  const identity = readJson(path.join(environments, environment, 'identity.json'));
  fs.writeFileSync(path.join(environments, environment, 'versions', identity.digest, 'tampered'), 'x');
  assert.equal((await supervisor.evaluate()).code, 'ENVIRONMENT_CHANGED');
  assert.equal(supervisor.status().phase, 'SEALED');
});

test('every trial contributes to acceptance and failed attempts are retained', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd), spec = contract();
  spec.scenarios[0].trials = 2;
  const flaky = driver.replace("const content = fs.readFileSync(file, 'utf8');", "const content = request.trial === 2 ? 'wrong' : fs.readFileSync(file, 'utf8');");
  ok(await supervisor.start('Finish feature')); ok(await supervisor.configure({ manifest, files: { 'driver.mjs': flaky } }));
  ok(await supervisor.draft(spec)); ok(await supervisor.approve());
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  const result = ok(await supervisor.evaluate());
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.run.results.map(value => value.status), ['PASS', 'FAIL']);
  assert.equal(supervisor.status().runCount, 1);
});

test('an always-passing observer fails the empty-target wiring check', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd), spec = contract();
  spec.scenarios[0].baseline = 'PASS';
  const always = `let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);console.log(JSON.stringify({protocol:1,status:'OK',observations:{content:'done\\n'}}));`;
  ok(await supervisor.start('Preserve feature')); ok(await supervisor.configure({ manifest, files: { 'driver.mjs': always } }));
  assert.equal((await supervisor.draft(spec)).code, 'WIRING_PASSED_EMPTY');
  assert.equal(supervisor.status().phase, 'DISCOVERY');
  assert.equal((await supervisor.approve()).code, 'NOT_READY');
});

test('schema failures, unavailable real targets, and cleanup failures are ERROR rather than useful baseline failures', async t => {
  for (const [source, code] of [
    [driver.replace('observations: { content }', 'observations: {}'), 'INVALID_OBSERVATION'],
    [driver.replace("const file = path.join(request.candidateDirectory, name);", "const file = path.join(request.candidateDirectory, 'missing');"), 'TARGET_UNAVAILABLE'],
    [driver.replace("if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });", "if(request.operation==='dispose') reply({status:'ERROR',reason:'cleanup failed'}); else if(request.operation==='prepare') reply({status:'OK'});"), 'CLEANUP_FAILED'],
  ]) {
    const cwd = workspace(t), supervisor = new ExitCode(cwd);
    ok(await supervisor.start('Finish feature')); ok(await supervisor.configure({ manifest, files: { 'driver.mjs': source } }));
    const result = await supervisor.draft(contract());
    assert.equal(result.code, code); assert.equal(supervisor.status().phase, 'DISCOVERY');
    assert.ok(supervisor.status().lastIssue.runId);
  }
});

test('canonical edits during validation invalidate evidence without discarding useful work', async t => {
  const { cwd, supervisor } = await ready(t);
  ok(await supervisor.approve());
  let changed = false;
  const racing = new ExitCode(cwd, { runner: async (...args) => {
    const { invoke } = await import('../exitcode-runner.mjs');
    const result = await invoke(...args);
    if (args[1].operation === 'run' && !changed) { changed = true; fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n'); }
    return result;
  } });
  assert.equal((await racing.evaluate()).code, 'CANDIDATE_CHANGED');
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'done\n');
  assert.equal(racing.status().phase, 'SEALED');
  assert.equal(ok(await racing.evaluate()).status, 'PASS');
});

test('environment construction is reused across tasks and setup cannot mutate the real product', async t => {
  const { cwd, supervisor, prepared } = await ready(t);
  assert.equal(prepared.preparation.warmEnvironment, false);
  const old = supervisor.status().task;
  const next = ok(await supervisor.start('Same unresolved problem'));
  assert.notEqual(next.task, old);
  assert.equal(supervisor.status(old).active, false);
  const second = ok(await supervisor.draft(contract()));
  assert.equal(second.preparation.warmEnvironment, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'pending\n');
});

test('refresh preserves the old sealed environment while a new task provisions a different one', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd), key = 'EXITCODE_TEST_RUNTIME';
  const source = driver.replace("if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });",
    "if(request.operation==='prepare'){fs.writeFileSync(path.join(request.runtimeDirectory,'version'),process.env.EXITCODE_TEST_RUNTIME);reply({status:'OK'});} else if(request.operation==='dispose')reply({status:'OK'});");
  const project = { manifest: { ...manifest, environment: [key] }, files: { 'driver.mjs': source } };
  process.env[key] = 'one'; t.after(() => delete process.env[key]);
  const first = ok(await supervisor.start('Finish feature')).task;
  ok(await supervisor.configure(project)); const original = ok(await supervisor.draft(contract())); ok(await supervisor.approve());
  ok(await supervisor.start('Another task')); process.env[key] = 'two';
  ok(await supervisor.configure(project, { refresh: true })); const updated = ok(await supervisor.draft(contract()));
  assert.notEqual(original.preparation.environment.digest, updated.preparation.environment.digest);
  ok(await supervisor.resume(first));
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  const result = ok(await supervisor.evaluate());
  assert.equal(result.status, 'PASS');
  assert.equal(result.run.environment.digest, original.preparation.environment.digest);
});

test('ownership, durable resume, external wait notes, and real evidence references', async t => {
  const { cwd, supervisor, id, prepared } = await ready(t);
  const stale = new ExitCode(cwd, { expectedTask: 'Twrong' });
  assert.equal((await stale.approve()).code, 'TASK_MISMATCH');
  const note = { hypothesis: 'Need credentials', change: '', result: 'No access', disposition: 'unresolved', next: 'Wait for key', evidence: [prepared.preparation.id], waitingFor: 'API key' };
  ok(await supervisor.note(note)); assert.equal(supervisor.status().waitingFor, 'API key');
  assert.equal((await supervisor.note({ ...note, evidence: ['Rinvented'] })).code, 'INVALID_NOTE');
  ok(await supervisor.wake()); assert.equal(supervisor.status().waitingFor, null);
  ok(await supervisor.detach());
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'useful edits\n');
  const restored = new ExitCode(cwd);
  ok(await restored.resume(id)); assert.equal(restored.status().phase, 'DISCOVERY');
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'useful edits\n');
  ok(await restored.draft(contract())); ok(await restored.approve()); ok(await restored.detach());
  ok(await new ExitCode(cwd).resume(id));
  assert.equal(new ExitCode(cwd).status().phase, 'SEALED');
});

test('only one workspace operation runs, including cancellation windows', async t => {
  const cwd = workspace(t); let release;
  const work = locked(cwd, 'first', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(locked(cwd, 'second', async () => {}), error => error.code === 'OPERATION_BUSY');
  release(); await work;
  await locked(cwd, 'third', async () => {});
});

test('cancellation during cleanup cannot certify an otherwise passing candidate', async t => {
  const { cwd, supervisor } = await ready(t); ok(await supervisor.approve());
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  const controller = new AbortController();
  const cancelled = new ExitCode(cwd, { signal: controller.signal, runner: async (...args) => {
    const { invoke } = await import('../exitcode-runner.mjs');
    const result = await invoke(...args);
    if (args[1].operation === 'dispose') controller.abort();
    return result;
  } });
  assert.equal((await cancelled.evaluate()).code, 'CANCELLED');
  assert.equal(supervisor.status().phase, 'SEALED');
});

test('single format rejects legacy stores and schemas; confined snapshots reject aliases', async t => {
  const cwd = workspace(t);
  fs.mkdirSync(path.join(cwd, DEFAULT_STORE_DIR), { recursive: true }); fs.writeFileSync(path.join(cwd, DEFAULT_STORE_DIR, 'index.json'), '{"formatVersion":2}');
  assert.equal((await new ExitCode(cwd, { storeDir: DEFAULT_STORE_DIR }).start('Problem')).code, 'UNSUPPORTED_FORMAT');
  assert.equal(readJson(path.join(cwd, DEFAULT_STORE_DIR, 'index.json')).formatVersion, 2);
  fs.rmSync(path.join(cwd, DEFAULT_STORE_DIR), { recursive: true });
  const supervisor = new ExitCode(cwd); ok(await supervisor.start('Problem')); ok(await supervisor.configure({ manifest, files: { 'driver.mjs': driver } }));
  assert.equal((await supervisor.draft({ ...contract(), execution: [] })).code, 'INVALID_SPEC');
  assert.equal((await supervisor.draft({ ...contract(), version: 2 })).code, 'UNSUPPORTED_FORMAT');
  assert.equal((await supervisor.draft({ ...contract(), happyPath: 'A prose happy path' })).code, 'INVALID_SPEC');
  assert.equal((await supervisor.configure({ manifest, files: { '../escape': 'x' } })).code, 'UNSAFE_PATH');
  fs.symlinkSync('/etc/hosts', path.join(cwd, 'outside'));
  assert.throws(() => treeDigest(cwd, { candidate: true }), error => error.code === 'UNSAFE_PATH');
});
