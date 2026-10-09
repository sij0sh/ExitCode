import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '../exitcode-core.mjs';
import { manifest, driver, contract } from './helpers.mjs';
import { harness } from './adapter-helpers.mjs';

async function prepared(t) {
  const h = await harness(t); await h.start(); await h.command('The feature is pending');
  assert.ok((await h.call('exitcode_project', { manifest, files: { 'driver.mjs': driver } })).details.ok);
  h.prepared = await h.call('exitcode_contract', contract());
  assert.ok(h.prepared.details.ok);
  return h;
}

test('factory is inert, tool exposure follows mode, and native tools and project prompt sections are preserved', async t => {
  const h = await harness(t); await h.start();
  assert.deepEqual(h.active(), ['read', 'write', 'bash', 'other']);
  assert.equal(h.tools.size, 4);
  assert.ok([...h.tools.values()].every(tool => tool.exposure === 'hidden'));
  await h.command('The feature is pending');
  assert.deepEqual(h.active(), ['read', 'write', 'bash', 'other', ...core.TOOL_NAMES]);
  const event = { systemPromptOptions: { sections: { project: 'AGENTS.md instructions' } } };
  h.events.get('before_agent_start')(event, h.ctx);
  assert.equal(event.systemPromptOptions.sections.project, 'AGENTS.md instructions');
  assert.match(event.systemPromptOptions.sections.exitcode, /Problem: The feature is pending/);
  await h.command('exit');
  assert.deepEqual(h.active(), ['read', 'write', 'bash', 'other']);
  h.events.get('before_agent_start')(event, h.ctx);
  assert.equal(event.systemPromptOptions.sections.exitcode, undefined);
});

test('review waits, user command approves, failed observations reach the agent, and only fresh PASS exits', async t => {
  const h = await prepared(t);
  assert.match(h.prepared.content[0].text, /Happy path/);
  assert.match(h.prepared.content[0].text, /No passing implementation witness/);
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  assert.equal((await h.call('exitcode_evaluate')).details.code, 'NOT_SEALED');
  h.setIdle(false); await h.command('approve');
  assert.match(h.notices.at(-1).text, /Finish or cancel/);
  h.setIdle(true); await h.command('approve');
  assert.equal(h.messages.at(-1).triggerTurn, true);
  const failed = await h.call('exitcode_evaluate');
  assert.equal(failed.details.status, 'FAIL');
  assert.match(failed.content[0].text, /observed "pending/);
  const inspected = await h.call('exitcode_evaluate', { inspect: 'run', runId: failed.details.run.id });
  assert.match(inspected.content[0].text, /Read-only run evidence/);
  assert.match(inspected.content[0].text, /observations/);
  assert.equal(new core.ExitCode(h.cwd).status().runCount, 1);
  assert.match((await h.call('exitcode_evaluate', { inspect: 'contract' })).content[0].text, /happyPath/);
  assert.equal((await h.call('exitcode_evaluate', { runId: '../invalid' })).details.code, 'INVALID_SPEC');
  fs.writeFileSync(path.join(h.cwd, 'feature.txt'), 'done\n');
  const pass = await h.call('exitcode_evaluate');
  assert.equal(pass.details.status, 'PASS');
  assert.equal(h.notices.at(-1).kind, 'info');
  assert.match(h.notices.at(-1).text, /ExitCode PASS/);
  assert.deepEqual(h.active(), ['read', 'write', 'bash', 'other']);
  assert.ok([...h.tools.values()].every(tool => tool.exposure === 'hidden'));
});

test('pre-approval product writes and supervisor access are guarded, bootstrap files remain accessible', async t => {
  const h = await prepared(t), guard = (toolName, input) => h.events.get('tool_call')({ toolName, input }, h.ctx);
  assert.equal(guard('write', { path: 'feature.txt', content: 'done' }).block, true);
  assert.equal(guard('read', { path: '.agents/.exitcode/state/index.json' }).block, true);
  assert.equal(guard('bash', { command: 'cat .agents/.exitcode/state/index.json' }).block, true);
  assert.equal(guard('read', { path: '.agents/.exitcode/project/manifest.json' }), undefined);
  assert.equal(guard('other', { arbitrary: true }), undefined);
  await h.command('approve');
  assert.equal(guard('write', { path: 'feature.txt', content: 'done' }), undefined);
  assert.equal(guard('read', { path: '.agents/.exitcode/state/index.json' }).block, true);
});

test('session reload retains ownership, fixed acceptance, notes, and external waits', async t => {
  const h = await prepared(t); await h.command('approve');
  const note = { hypothesis: 'Need external data', change: '', result: 'Unavailable', disposition: 'unresolved', next: 'Ask user', evidence: [], waitingFor: 'Example input' };
  assert.ok((await h.call('exitcode_note', note)).details.ok);
  await h.reload();
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  await h.events.get('input')({ source: 'interactive', text: 'Here is the input' }, h.ctx);
  assert.equal(new core.ExitCode(h.cwd).status().waitingFor, null);
  const prompt = { systemPromptOptions: { sections: {} } };
  h.events.get('before_agent_start')(prompt, h.ctx);
  assert.match(prompt.systemPromptOptions.sections.exitcode, /Working hypothesis: Need external data/);
  assert.ok(prompt.systemPromptOptions.sections.exitcode.length < 4096);
});

test('continuation is bounded and does not introduce a decomposition or scheduling system', async t => {
  const h = await harness(t); await h.start(); await h.command('The feature is pending');
  assert.equal((await h.events.get('agent_before_settle')({}, h.ctx)).continue, true);
  assert.equal((await h.events.get('agent_before_settle')({}, h.ctx)).continue, true);
  assert.equal(await h.events.get('agent_before_settle')({}, h.ctx), undefined);
  assert.ok(!h.tools.has('exitcode_child'));
  assert.ok(!h.tools.has('exitcode_seal'));
});
