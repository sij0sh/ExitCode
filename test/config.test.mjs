import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../exitcode-config.mjs';
import { ExitCode } from '../exitcode-core.mjs';
import { DEFAULT_STORE_DIR } from '../exitcode-files.mjs';
import { manifest, driver, contract } from './helpers.mjs';
import { harness } from './adapter-helpers.mjs';

async function prepare(h) {
  assert.ok((await h.call('exitcode_project', { manifest, files: { 'driver.mjs': driver } })).details.ok);
  assert.ok((await h.call('exitcode_contract', contract())).details.ok);
}
const inspected = async h => { await h.command('config'); return JSON.parse(h.notices.at(-1).text); };

test('defaults and trusted partial overrides merge by key without creating state', async t => {
  const h = await harness(t, { user: { storeDir: '.cache/exitcode', maxNudges: 0, showStatus: false }, project: { storeDir: '.validation/exitcode' } });
  await h.start(); const before = fs.readdirSync(h.cwd).sort();
  const effective = await inspected(h);
  assert.deepEqual({ storeDir: effective.storeDir, maxNudges: effective.maxNudges, showStatus: effective.showStatus },
    { storeDir: '.validation/exitcode', maxNudges: 0, showStatus: false });
  assert.equal(effective.sources.user.path, h.files.user); assert.equal(effective.sources.user.loaded, true);
  assert.equal(effective.sources.project.path, h.files.project); assert.equal(effective.sources.project.loaded, true);
  await h.command('status'); assert.ok(h.notices.at(-1).text.includes(effective.storePath));
  await h.command('exit');
  assert.deepEqual(fs.readdirSync(h.cwd).sort(), before); assert.equal(h.entries.length, 0); assert.equal(h.messages.length, 0);
  const defaults = await harness(t); await defaults.start();
  const value = await inspected(defaults);
  for (const [key, expected] of Object.entries(DEFAULT_CONFIG)) assert.equal(value[key], expected);
  assert.equal(value.sources.user.loaded, false); assert.equal(value.sources.project.loaded, false);
  assert.ok(!fs.existsSync(path.join(defaults.cwd, DEFAULT_STORE_DIR)));
});

test('untrusted project settings are not read, including malformed JSON', async t => {
  const h = await harness(t, { trusted: false, user: { storeDir: '.cache/exitcode' }, project: '{bad JSON' });
  await h.start(); const effective = await inspected(h);
  assert.equal(effective.storeDir, '.cache/exitcode'); assert.equal(effective.sources.project.loaded, false);
  assert.equal(effective.sources.project.trusted, false);
  assert.ok(!h.notices.some(notice => notice.kind === 'error'));
});

test('schema validation rejects unknown keys, non-objects, bad types and unsafe storage with source diagnostics', async t => {
  const h = await harness(t), file = h.files.project;
  const invalid = ['{bad JSON', 'null', '[]', 'false', '"text"', { unknown: true }, { storeDir: null }, { storeDir: '.' }, { storeDir: '../shared' },
    { showStatus: null }, { showStatus: 'false' }, { maxNudges: -1 }, { maxNudges: 11 }, { maxNudges: 1.5 }, { maxNudges: '2' }, { maxNudges: null }];
  for (const value of invalid) {
    const source = typeof value === 'string' ? value : JSON.stringify(value);
    assert.throws(() => parseConfig(source, file, h.cwd), error => error.code === 'INVALID_CONFIG' && error.message.includes(file));
  }
  for (const value of [{ maxNudges: 0 }, { maxNudges: 10 }, { showStatus: false }, { storeDir: '.cache/exitcode' }, {}])
    assert.deepEqual(parseConfig(JSON.stringify(value), file, h.cwd), value);
});

test('configuration read failures do not masquerade as missing files or silently fall back', async t => {
  const h = await harness(t);
  fs.mkdirSync(h.files.user);
  assert.throws(() => loadConfig(h.cwd, { agentDir: h.agentDir, projectTrusted: true }), error => error.code === 'INVALID_CONFIG' && error.message.includes(h.files.user));
});

test('invalid configuration blocks task creation until reload repairs the file', async t => {
  for (const scope of ['user', 'project']) {
    const h = await harness(t, { [scope]: { maxNudges: 'many' } }); await h.start();
    await h.command('The feature is pending');
    assert.equal(h.messages.length, 0); assert.ok(!fs.existsSync(path.join(h.cwd, DEFAULT_STORE_DIR)));
    assert.ok(h.notices.some(notice => notice.text.includes(h.files[scope])));
    h.settings(scope, { maxNudges: 0 }); await h.command('The feature is pending');
    assert.equal(h.messages.length, 0, 'editing alone does not refresh settings');
    await h.reload(); await h.command('The feature is pending'); assert.equal(h.messages.length, 1);
  }
});

test('reload pins the active store and reports the pending configured path until exit', async t => {
  const oldDir = '.validation/exitcode', newDir = '.next/exitcode', h = await harness(t, { project: { storeDir: oldDir } });
  await h.start(); await h.command('The feature is pending'); await prepare(h); await h.command('approve');
  const before = new ExitCode(h.cwd, { storeDir: oldDir }).status(undefined, true);
  h.settings('project', { storeDir: newDir, showStatus: false }); await h.reload();
  const effective = await inspected(h);
  assert.equal(effective.storeDir, newDir); assert.equal(effective.activeStoreDir, oldDir);
  await h.command('status'); assert.ok(h.notices.at(-1).text.includes(path.join(h.cwd, oldDir)));
  assert.equal(h.guard('read', { path: path.join(oldDir, 'state', 'index.json') }).block, true);
  assert.equal(new ExitCode(h.cwd, { storeDir: oldDir }).status(undefined, true).sealedDigest, before.sealedDigest);
  assert.ok(!fs.existsSync(path.join(h.cwd, newDir)));
  await h.command('exit'); await h.command('Another feature is pending');
  assert.ok(fs.existsSync(path.join(h.cwd, newDir, 'state', 'index.json')));
  assert.ok(fs.existsSync(path.join(h.cwd, oldDir, 'state', 'tasks', before.task, 'sealed.json')));
});

test('invalid reload preserves existing ownership and allows explicit exit without adopting another store', async t => {
  const oldDir = '.validation/exitcode', h = await harness(t, { project: { storeDir: oldDir } });
  await h.start(); await h.command('The feature is pending');
  h.settings('project', '{bad JSON'); await h.reload(); await h.command('status');
  assert.ok(h.notices.at(-1).text.includes(path.join(h.cwd, oldDir)));
  assert.equal(h.guard('write', { path: 'feature.txt', content: 'done' }).block, true);
  await h.command('exit'); assert.equal(new ExitCode(h.cwd, { storeDir: oldDir }).status().active, false);
  const count = h.messages.length; await h.command('Another task'); assert.equal(h.messages.length, count);
});

test('user default storage is resolved against the project, not the agent directory', async t => {
  const h = await harness(t, { user: { storeDir: '.validation/exitcode' } }); await h.start();
  const value = await inspected(h); assert.equal(value.storePath, path.join(h.cwd, '.validation', 'exitcode'));
  await h.command('The feature is pending');
  assert.ok(fs.existsSync(path.join(value.storePath, 'state', 'index.json')));
  assert.ok(!fs.existsSync(path.join(h.agentDir, '.validation')));
});
