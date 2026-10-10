import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ExitCode } from '../exitcode-core.mjs';
import { allocateScratch, DEFAULT_STORE_DIR, digest, inventory, readJson } from '../exitcode-files.mjs';
import { invoke } from '../exitcode-runner.mjs';
import { workspace, manifest, driver, contract, ok, ready } from './helpers.mjs';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function trackRequests(requests, work) {
  return async (...args) => {
    requests.push({ ...args[1] });
    return work ? work(...args) : invoke(...args);
  };
}
function removed(requests) {
  for (const request of requests) assert.ok(!fs.existsSync(request.runDirectory), request.runDirectory);
}

test('setup and trials use external scratch without inheriting host Git ancestry; evidence and runtime survive', { skip: !gitAvailable }, async t => {
  const host = workspace(t); assert.equal(git(host, ['init', '--quiet']).status, 0);
  const cwd = path.join(host, 'product'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'feature.txt'), 'pending\n');
  const requests = [], supervisor = new ExitCode(cwd, { runner: trackRequests(requests, async (...args) => {
    const request = args[1];
    assert.ok(!inside(host, request.runDirectory));
    for (const directory of [request.candidateDirectory, request.projectDirectory, request.runDirectory]) {
      const result = git(directory, ['rev-parse', '--show-toplevel']);
      assert.notEqual(result.status, 0, result.stdout || directory);
    }
    if (request.operation === 'run') {
      const fixture = path.join(request.runDirectory, 'work', 'fixture'); fs.mkdirSync(fixture, { recursive: true });
      assert.notEqual(git(fixture, ['rev-parse', '--show-toplevel']).status, 0);
      assert.equal(git(fixture, ['init', '--quiet']).status, 0);
      assert.equal(git(fixture, ['rev-parse', '--show-toplevel']).stdout.trim(), fixture);
    }
    return invoke(...args);
  }) });
  const id = ok(await supervisor.start('Finish the feature')).task;
  const before = digest(inventory(cwd, { candidate: true }));
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': driver } }));
  const prepared = ok(await supervisor.draft(contract()));
  assert.equal(prepared.preparation.candidateDigest, before);
  assert.equal(digest(inventory(cwd, { candidate: true })), before);
  removed(requests);
  const environment = supervisor.load(id).prepared.run.environment;
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments', digest(supervisor.project()), 'versions', environment.digest)));
  for (const trial of prepared.preparation.results.filter(trial => !trial.wiring)) {
    const durable = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'runs', prepared.preparation.id, `${trial.scenario}-${trial.trial}`);
    assert.equal(fs.readFileSync(path.join(durable, trial.artifacts[0].path), 'utf8'), 'pending\n');
    assert.ok(fs.existsSync(path.join(durable, 'run.stdout')));
    assert.ok(!fs.existsSync(path.join(durable, 'work')));
  }
  ok(await supervisor.approve()); fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  assert.equal(ok(await supervisor.evaluate()).status, 'PASS'); removed(requests);
});

test('cancellation stops the real trial process and removes its external scratch while ERROR evidence remains', async t => {
  const controller = new AbortController(), requests = [];
  const { cwd, supervisor, id } = await ready(t); ok(await supervisor.approve());
  const cancelled = new ExitCode(cwd, { signal: controller.signal, runner: trackRequests(requests, async (...args) => {
    if (args[1].operation === 'run') {
      const running = invoke({ ...args[0], command: { program: 'node', args: ['-e', 'setInterval(() => {}, 1000);'] } }, args[1], args[2]);
      setTimeout(() => controller.abort(), 50); return running;
    }
    return invoke(...args);
  }) });
  const result = await cancelled.evaluate();
  assert.equal(result.code, 'CANCELLED'); removed(requests);
  const record = readJson(cancelled.evidenceFile(id, result.runId));
  assert.equal(record.status, 'ERROR'); assert.equal(record.results[0].trial, 1);
  assert.equal(cancelled.status().phase, 'SEALED');
});

test('setup and trial error responses copy requested bounded artifacts before scratch cleanup', async t => {
  const requests = [], cwd = workspace(t);
  const source = driver.replace("if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });",
    `if(request.operation==='prepare') { fs.writeFileSync(path.join(request.runDirectory,'prepared.txt'),'setup diagnostic'); reply({status:'OK',artifacts:['prepared.txt']}); }
     else if(request.operation==='dispose') reply({status:'OK'});`)
    .replace("reply({ status: 'OK', observations: { content }, artifacts: ['artifacts/observed.txt'] });",
      "reply({ status: 'ERROR', reason: 'Measured command could not run', artifacts: ['artifacts/observed.txt'] });");
  const supervisor = new ExitCode(cwd, { runner: trackRequests(requests) }), id = ok(await supervisor.start('Finish the feature')).task;
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': source } }));
  const failed = await supervisor.draft(contract()); assert.equal(failed.code, 'RUNNER_ERROR'); removed(requests);
  const taskRoot = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id);
  const setupDirectory = path.join(taskRoot, fs.readdirSync(taskRoot).find(name => name.startsWith('environment-setup-')));
  const setup = readJson(path.join(setupDirectory, 'result.json'));
  assert.equal(setup.status, 'PASS'); assert.equal(setup.artifacts[0].path, 'evidence/prepared.txt');
  assert.equal(fs.readFileSync(path.join(setupDirectory, setup.artifacts[0].path), 'utf8'), 'setup diagnostic');
  const run = readJson(supervisor.evidenceFile(id, failed.runId)), trial = run.results[0];
  assert.equal(trial.status, 'ERROR'); assert.equal(trial.artifacts[0].path, 'evidence/artifacts/observed.txt');
  assert.equal(fs.readFileSync(path.join(taskRoot, 'runs', failed.runId, 'feature-1', trial.artifacts[0].path), 'utf8'), 'pending\n');
});

test('unsafe TMPDIR under the product or a Git ancestor fails closed instead of falling back', { skip: !gitAvailable }, async t => {
  const cwd = workspace(t), external = workspace(t), previous = process.env.TMPDIR;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  process.env.TMPDIR = path.join(cwd, 'tmp'); fs.mkdirSync(process.env.TMPDIR);
  assert.throws(() => allocateScratch(cwd), error => error.code === 'UNSAFE_PATH' && /outside the product/.test(error.message));
  assert.equal(git(external, ['init', '--quiet']).status, 0);
  process.env.TMPDIR = path.join(external, 'scratch'); fs.mkdirSync(process.env.TMPDIR);
  assert.throws(() => allocateScratch(cwd), error => error.code === 'UNSAFE_PATH' && /Git ancestry/.test(error.message));
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
  const supervisor = new ExitCode(cwd), id = ok(await supervisor.start('Finish the feature')).task;
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': driver } }));
  const failed = await supervisor.draft(contract());
  assert.equal(failed.code, 'UNSAFE_PATH'); assert.equal(failed.stage, 'scratch-create');
  assert.match(failed.runId, /^E/); assert.equal(readJson(supervisor.evidenceFile(id, failed.runId)).status, 'ERROR');
});

test('runtime copy failure cleans both OS scratch and unfinished durable staging without false PASS', async t => {
  const requests = [], cwd = workspace(t), supervisor = new ExitCode(cwd, { runner: trackRequests(requests) });
  const source = driver.replace("if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });",
    "if(request.operation==='prepare') { fs.writeFileSync(path.join(request.runtimeDirectory,'runtime.txt'),'runtime bytes'); reply({status:'OK'}); } else if(request.operation==='dispose') reply({status:'OK'});");
  const id = ok(await supervisor.start('Finish the feature')).task;
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': source } }));
  const original = fs.copyFileSync;
  t.after(() => { fs.copyFileSync = original; syncBuiltinESMExports(); });
  fs.copyFileSync = (source, destination, ...args) => {
    if (destination.includes('/preparing-')) throw Object.assign(new Error('Injected finalization copy failure'), { code: 'EIO' });
    return original(source, destination, ...args);
  };
  syncBuiltinESMExports();
  const failed = await supervisor.draft(contract());
  assert.equal(failed.code, 'EIO'); assert.equal(failed.stage, 'runtime-finalize'); removed(requests);
  assert.equal(readJson(supervisor.evidenceFile(id, failed.runId)).status, 'ERROR');
  const environment = path.join(cwd, DEFAULT_STORE_DIR, 'state', 'environments', digest(supervisor.project()));
  assert.ok(!fs.readdirSync(environment).some(name => name.startsWith('preparing-')));
  assert.ok(!fs.existsSync(path.join(environment, 'identity.json')));
});
