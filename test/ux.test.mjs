import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { manifest, driver, contract } from './helpers.mjs';
import { harness, footer } from './adapter-helpers.mjs';

async function prepare(h) {
  assert.ok((await h.call('exitcode_project', { manifest, files: { 'driver.mjs': driver } })).details.ok);
  assert.ok((await h.call('exitcode_contract', contract())).details.ok);
}

test('help and completions expose the supported commands without starting a task', async t => {
  const h = await harness(t); await h.start(); await h.command('help');
  assert.match(h.notices.at(-1).text, /config/); assert.match(h.notices.at(-1).text, /maxNudges/);
  assert.ok(h.complete('sta').some(item => item.value === 'status'));
  assert.deepEqual(h.complete('status e'), [{ value: 'status evidence', label: 'status evidence' }]);
  assert.ok(h.complete('').some(item => item.value === 'config')); assert.equal(h.complete('unknown'), null);
  assert.equal(h.messages.length, 0); assert.equal(h.entries.length, 0);
});

test('native footer reflects phase, progress, failures, waits and clears after fresh PASS', async t => {
  const h = await harness(t); await h.start(); await h.command('The feature is pending');
  assert.match(footer(h), /DISCOVERY/); await prepare(h); assert.match(footer(h), /READY.*approve/);
  assert.ok(h.updates.some(update => /run feature/.test(update.text ?? '')));
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  await h.command('approve'); assert.match(footer(h), /SEALED/);
  assert.equal((await h.call('exitcode_evaluate')).details.status, 'FAIL'); assert.match(footer(h), /FAIL/);
  assert.ok((await h.call('exitcode_note', { hypothesis: 'Need input', change: '', result: '', disposition: 'unresolved', next: 'Ask', evidence: [], waitingFor: 'Example' })).details.ok);
  assert.match(footer(h), /waiting/); assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  await h.events.get('input')({ source: 'interactive', text: 'Example supplied' }, h.ctx);
  assert.doesNotMatch(footer(h), /waiting/);
  fs.writeFileSync(path.join(h.cwd, 'feature.txt'), 'done\n');
  assert.equal((await h.call('exitcode_evaluate')).details.status, 'PASS'); assert.equal(footer(h), '');
});

test('maxNudges bounds unchanged continuation and new progress resets the budget', async t => {
  const h = await harness(t, { project: { maxNudges: 1 } }); await h.start(); await h.command('The feature is pending');
  const settle = () => h.events.get('agent_before_settle')({}, h.ctx);
  assert.equal((await settle()).continue, true); assert.equal(await settle(), undefined);
  assert.ok((await h.call('exitcode_note', { hypothesis: 'Investigated', change: '', result: '', disposition: 'keep', next: 'Prepare', evidence: [] })).details.ok);
  assert.equal((await settle()).continue, true); assert.equal(await settle(), undefined);
  await h.events.get('input')({ source: 'interactive', text: 'Continue' }, h.ctx);
  assert.equal((await settle()).continue, true); assert.equal(await settle(), undefined);
  await prepare(h); assert.equal(await settle(), undefined, 'approval is never automatic');
});

test('zero nudges and disabled footer retain auditing, product guards and explicit approval', async t => {
  const h = await harness(t, { project: { maxNudges: 0, showStatus: false } }); await h.start(); await h.command('The feature is pending');
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined); assert.equal(footer(h), '');
  assert.equal(h.guard('write', { path: 'feature.txt', content: 'done' }).block, true);
  assert.equal((await h.call('exitcode_evaluate')).details.code, 'NOT_SEALED');
  await prepare(h); fs.writeFileSync(path.join(h.cwd, 'feature.txt'), 'changed');
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  await h.command('status'); assert.match(h.notices.at(-1).text, /DISCOVERY/);
  assert.match(h.notices.at(-1).text, /CANDIDATE_CHANGED/); assert.equal(footer(h), '');
  await h.command('exit'); assert.equal(footer(h), '');
});

test('print, JSON and RPC behavior does not depend on a terminal footer', async t => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = await harness(t, { mode }); await h.start(); await h.command('The feature is pending');
    assert.equal(h.updates.length, 0);
    assert.equal(h.guard('write', { path: 'feature.txt', content: 'done' }).block, true);
    await h.command('status'); assert.match(h.notices.at(-1).text, /DISCOVERY/);
    await h.command('exit'); assert.equal(h.updates.length, 0);
  }
});

test('configured path guards cover private ancestors, absolute paths and aliases but keep bootstrap readable', async t => {
  const storeDir = '.validation/exitcode', h = await harness(t, { project: { storeDir } }); await h.start(); await h.command('The feature is pending'); await prepare(h);
  const state = path.join(h.cwd, storeDir, 'state'), project = path.join(h.cwd, storeDir, 'project');
  for (const file of [state, path.join(state, 'index.json'), path.dirname(state)])
    assert.equal(h.guard('read', { path: file }).block, true, file);
  assert.equal(h.guard('ls', { path: '.' }), undefined, 'normal workspace discovery stays available');
  assert.equal(h.guard('read', { path: path.join(h.cwd, '.validation') }), undefined);
  assert.equal(h.guard('write', { path: path.join(h.cwd, '.validation'), content: '' }).block, true);
  assert.equal(h.guard('read', { path: path.join(project, 'manifest.json') }), undefined);
  assert.equal(h.guard('bash', { command: `head ${project}/manifest.json` }), undefined);
  assert.equal(h.guard('bash', { command: `head ${storeDir}-sibling.txt` }), undefined);
  assert.equal(h.guard('bash', { command: `head ${storeDir}/state/index.json` }).block, true);
  assert.equal(h.guard('bash', { command: `head ${storeDir}/project/../state/index.json` }).block, true);
  fs.symlinkSync(state, path.join(h.cwd, 'private-alias'));
  assert.equal(h.guard('read', { path: 'private-alias/index.json' }).block, true);
  fs.unlinkSync(path.join(h.cwd, 'private-alias'));
  await h.command('approve');
  assert.equal(h.guard('write', { path: 'feature.txt', content: 'done' }), undefined);
  assert.equal(h.guard('read', { path: path.join(state, 'index.json') }).block, true);
});

test('footer clears on explicit exit and shutdown', async t => {
  const h = await harness(t); await h.start(); await h.command('The feature is pending'); assert.ok(footer(h));
  await h.command('exit'); assert.equal(footer(h), ''); await h.command('Another task'); assert.ok(footer(h));
  await h.events.get('session_shutdown')({}, h.ctx); assert.equal(footer(h), '');
});
