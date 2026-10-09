import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExitCode } from '../exitcode-core.mjs';
import { DEFAULT_STORE_DIR, resolveStoreDir, inventory, copyTree, treeDigest, locked } from '../exitcode-files.mjs';
import { workspace, manifest, driver, contract, ok, ready } from './helpers.mjs';

const note = { hypothesis: 'Private storage is separate', change: '', result: '', disposition: 'keep', next: 'Finish feature', evidence: [] };

test('status is read-only and complete default storage is created only by an operation', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd), before = fs.readdirSync(cwd);
  assert.equal(supervisor.status().storePath, path.join(cwd, DEFAULT_STORE_DIR));
  assert.deepEqual(fs.readdirSync(cwd), before);
  ok(await supervisor.start('Finish feature'));
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': driver } }));
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'project', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'index.json')));
  assert.ok(!fs.existsSync(path.join(cwd, '.exitcode')));
});

test('nested storage supports approval, failures, resume and fresh PASS without hiding sibling products', async t => {
  const storeDir = '.cache/validation', { cwd, supervisor, id } = await ready(t, { storeDir });
  const before = ok(await supervisor.audit()).candidateDigest;
  ok(await supervisor.note(note));
  assert.equal(ok(await supervisor.audit()).candidateDigest, before);
  fs.writeFileSync(path.join(cwd, '.cache', 'product.txt'), 'useful edit');
  assert.equal((await supervisor.approve()).code, 'CANDIDATE_CHANGED');
  assert.equal(fs.readFileSync(path.join(cwd, '.cache', 'product.txt'), 'utf8'), 'useful edit');
  ok(await supervisor.resume(id)); ok(await supervisor.draft(contract())); ok(await supervisor.approve());
  assert.equal(ok(await supervisor.evaluate()).status, 'FAIL');
  const sealedDigest = supervisor.status(id, true).sealedDigest;
  ok(await supervisor.detach());
  const restored = new ExitCode(cwd, { storeDir }); ok(await restored.resume(id));
  assert.equal(restored.status(id, true).sealedDigest, sealedDigest);
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n');
  const result = ok(await restored.evaluate());
  assert.equal(result.status, 'PASS');
  assert.ok(new ExitCode(cwd, { storeDir }).freshPass(id));
  assert.ok(fs.existsSync(path.join(cwd, storeDir, 'state', 'tasks', id, 'runs', result.run.id, 'run.json')));
  assert.ok(!fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR)));
});

test('candidate snapshots exclude only the selected store and Git, including their link aliases', async t => {
  const cwd = workspace(t), storeDir = '.cache/validation', supervisor = new ExitCode(cwd, { storeDir });
  ok(await supervisor.start('Problem'));
  fs.mkdirSync(path.join(cwd, '.git')); fs.writeFileSync(path.join(cwd, '.git', 'config'), 'metadata');
  fs.mkdirSync(path.join(cwd, '.agents')); fs.writeFileSync(path.join(cwd, '.agents', 'product.txt'), 'agent product');
  fs.writeFileSync(path.join(cwd, '.cache', 'validation-sibling'), 'cache product');
  const snapshot = workspace(t); fs.rmSync(path.join(snapshot, 'feature.txt'));
  copyTree(cwd, snapshot, { candidate: true, storeDir });
  assert.ok(!fs.existsSync(path.join(snapshot, storeDir)));
  assert.ok(!fs.existsSync(path.join(snapshot, '.git')));
  assert.equal(fs.readFileSync(path.join(snapshot, '.cache', 'validation-sibling'), 'utf8'), 'cache product');
  assert.equal(treeDigest(snapshot), treeDigest(cwd, { candidate: true, storeDir }));
  fs.symlinkSync(path.join(cwd, storeDir, 'state'), path.join(cwd, 'alias'));
  assert.throws(() => inventory(cwd, { candidate: true, storeDir }), error => error.code === 'UNSAFE_PATH');
});

test('unsafe storage paths reject before creating state or overwriting product files', async t => {
  const cwd = workspace(t);
  for (const storeDir of ['', '.', '..', '../shared', '/tmp/shared', '~/shared', '.git', '.git/state', 'cache/.git/state', 'cache/../state', 'cache//state', 'cache\\state', 'C:/state', 'bad\nstate', ' ']) {
    assert.equal((await new ExitCode(cwd, { storeDir }).start('Problem')).code, 'UNSAFE_PATH', storeDir);
  }
  fs.mkdirSync(path.join(cwd, 'product')); fs.writeFileSync(path.join(cwd, 'product', 'source.txt'), 'keep');
  assert.equal((await new ExitCode(cwd, { storeDir: 'product' }).start('Problem')).code, 'UNSAFE_PATH');
  assert.equal(fs.readFileSync(path.join(cwd, 'product', 'source.txt'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR)));
  assert.equal(resolveStoreDir(cwd, '.validation/exitcode'), path.join(cwd, '.validation', 'exitcode'));
});

test('symlink components, dangling aliases and private index aliases fail closed', async t => {
  for (const dangling of [false, true]) {
    const cwd = workspace(t), target = workspace(t);
    fs.symlinkSync(dangling ? path.join(target, 'missing') : target, path.join(cwd, '.cache'));
    assert.equal((await new ExitCode(cwd, { storeDir: '.cache/validation' }).start('Problem')).code, 'UNSAFE_PATH');
    assert.ok(!fs.existsSync(path.join(target, 'validation')));
  }
  for (const alias of ['state', 'state/index.json']) {
    const cwd = workspace(t), target = workspace(t), storeDir = '.validation/exitcode', base = path.join(cwd, storeDir);
    fs.mkdirSync(alias === 'state' ? base : path.join(base, 'state'), { recursive: true });
    fs.symlinkSync(alias === 'state' ? target : path.join(target, 'feature.txt'), path.join(base, alias));
    assert.equal((await new ExitCode(cwd, { storeDir }).start('Problem')).code, 'UNSAFE_PATH');
    assert.equal(fs.readFileSync(path.join(target, 'feature.txt'), 'utf8'), 'pending\n');
  }
});

test('the old location is explicit, current-format stores remain usable, and legacy bytes remain untouched', async t => {
  const cwd = workspace(t), storeDir = '.exitcode', base = path.join(cwd, storeDir), supervisor = new ExitCode(cwd, { storeDir });
  const id = ok(await supervisor.start('Problem')).task;
  assert.equal(new ExitCode(cwd, { storeDir }).status().task, id);
  assert.equal(new ExitCode(cwd).status().task, undefined);
  assert.ok(!fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR)));
  fs.writeFileSync(path.join(base, 'index.json'), '{"formatVersion":2}');
  assert.equal((await new ExitCode(cwd, { storeDir }).start('Problem')).code, 'UNSUPPORTED_FORMAT');
  assert.equal(fs.readFileSync(path.join(base, 'index.json'), 'utf8'), '{"formatVersion":2}');
});

test('custom-store locks reject overlap and are released before the next operation', async t => {
  const cwd = workspace(t), storeDir = '.validation/exitcode'; let release;
  const work = locked(cwd, 'first', () => new Promise(resolve => { release = resolve; }), storeDir);
  await assert.rejects(locked(cwd, 'second', async () => {}, storeDir), error => error.code === 'OPERATION_BUSY');
  release(); await work;
  await locked(cwd, 'third', async () => {}, storeDir);
  assert.ok(!fs.existsSync(path.join(cwd, storeDir, 'state', 'operation.lock')));
});

test('canonical edits during custom-store validation remain stale evidence', async t => {
  const storeDir = '.validation/exitcode', { cwd, supervisor } = await ready(t, { storeDir }); ok(await supervisor.approve());
  let changed = false;
  const racing = new ExitCode(cwd, { storeDir, runner: async (...args) => {
    const { invoke } = await import('../exitcode-runner.mjs'); const result = await invoke(...args);
    if (args[1].operation === 'run' && !changed) { changed = true; fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n'); }
    return result;
  } });
  assert.equal((await racing.evaluate()).code, 'CANDIDATE_CHANGED');
  assert.equal(racing.status().phase, 'SEALED');
  assert.equal(ok(await racing.evaluate()).status, 'PASS');
});
