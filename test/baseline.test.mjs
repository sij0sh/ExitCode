import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExitCode, promptStatus } from '../exitcode-core.mjs';
import { digest, sha, inventory, readJson, DEFAULT_STORE_DIR } from '../exitcode-files.mjs';
import { workspace, manifest, driver, contract, ok, ready } from './helpers.mjs';

const baselineFile = (supervisor, id) => supervisor.baselineFile(supervisor.load(id));

test('start and explicit unsealed resume persist the exact full-content inventory used for the digest', async t => {
  const cwd = workspace(t);
  fs.mkdirSync(path.join(cwd, 'target')); fs.writeFileSync(path.join(cwd, 'target', 'ignored.bin'), 'ignored input');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'target/\n');
  fs.symlinkSync('feature.txt', path.join(cwd, 'feature-link'));
  const supervisor = new ExitCode(cwd), id = ok(await supervisor.start('Finish the feature')).task;
  const originalFile = baselineFile(supervisor, id), original = readJson(originalFile);
  assert.deepEqual(original, inventory(cwd, { candidate: true }));
  assert.equal(digest(original), supervisor.load(id).baselineDigest);
  assert.equal(original.find(entry => entry.path === 'target/ignored.bin').sha, sha('ignored input'));
  assert.equal(original.find(entry => entry.path === 'feature-link').target, 'feature.txt');
  assert.ok(!JSON.stringify(original).includes('pending'), 'Only metadata and hashes are stored, not file contents');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'changed');
  ok(await supervisor.resume(id));
  const adopted = readJson(baselineFile(supervisor, id));
  assert.deepEqual(adopted, inventory(cwd, { candidate: true }));
  assert.equal(digest(adopted), supervisor.load(id).baselineDigest);
  assert.notEqual(baselineFile(supervisor, id), originalFile);
  assert.deepEqual(readJson(originalFile), original, 'Previous inventories remain historical diagnostics');
  assert.equal(ok(await supervisor.audit()).candidateDigest, digest(adopted));
});

test('baseline mismatch reports digests and at most eight paths with modes, links, additions and deletions', async t => {
  const cwd = workspace(t);
  fs.writeFileSync(path.join(cwd, 'removed.txt'), 'old');
  fs.symlinkSync('feature.txt', path.join(cwd, 'link'));
  fs.writeFileSync(path.join(cwd, 'mode.txt'), 'same'); fs.chmodSync(path.join(cwd, 'mode.txt'), 0o600);
  const supervisor = new ExitCode(cwd), id = ok(await supervisor.start('Finish the feature')).task;
  const before = supervisor.load(id).baselineDigest;
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'changed\n');
  fs.unlinkSync(path.join(cwd, 'removed.txt'));
  fs.chmodSync(path.join(cwd, 'mode.txt'), 0o700);
  fs.unlinkSync(path.join(cwd, 'link')); fs.symlinkSync('mode.txt', path.join(cwd, 'link'));
  for (let index = 0; index < 12; index++) fs.writeFileSync(path.join(cwd, `z-${index}`), 'new');
  const result = await supervisor.audit(), changes = result.diagnostics.baseline;
  assert.equal(result.code, 'CANDIDATE_CHANGED'); assert.equal(result.stage, 'baseline-check');
  assert.equal(changes.comparison, 'baseline/current');
  assert.equal(changes.baselineDigest, before);
  assert.equal(changes.currentDigest, digest(inventory(cwd, { candidate: true })));
  assert.equal(changes.totalDifferences, 16); assert.equal(changes.differences.length, 8);
  const byPath = Object.fromEntries(changes.differences.map(entry => [entry.path, entry]));
  assert.deepEqual(byPath['feature.txt'].fields, ['sha']);
  assert.deepEqual(byPath.link.fields, ['target']);
  assert.deepEqual(byPath['mode.txt'].fields, ['mode']);
  assert.equal(byPath['removed.txt'].actual, null);
  assert.equal(byPath['z-0'].expected, null);
  assert.match(result.message, /feature\.txt.*sha/); assert.match(result.message, /8 more paths/);
  assert.equal(supervisor.status().lastIssue.diagnostics.baseline.currentDigest, changes.currentDigest);
  assert.equal(supervisor.load(id).baselineDigest, before, 'A diagnostic never adopts changed product bytes');
});

test('successful unsealed resume clears the current issue but retains error evidence and the reusable driver', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd);
  const id = ok(await supervisor.start('Finish the feature')).task;
  const invalid = 'console.log(JSON.stringify({protocol:1,status:"ready"}));';
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': invalid } }));
  const failed = await supervisor.draft(contract());
  assert.equal(failed.code, 'INVALID_REPORT');
  const evidenceFile = supervisor.evidenceFile(id, failed.runId), evidence = fs.readFileSync(evidenceFile, 'utf8');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'new baseline');
  assert.equal((await supervisor.audit()).code, 'CANDIDATE_CHANGED');
  assert.match(promptStatus(supervisor.status()), /Issue: CANDIDATE_CHANGED/);
  const resumed = ok(await supervisor.resume(id));
  assert.match(resumed.next, /Reuse the stored driver/);
  assert.equal(supervisor.status().lastIssue, undefined);
  assert.doesNotMatch(promptStatus(supervisor.status()), /Issue:/);
  assert.equal(supervisor.status().lastEvidenceId, failed.runId);
  assert.equal(fs.readFileSync(evidenceFile, 'utf8'), evidence);
  assert.equal(supervisor.project().files['driver.mjs'], invalid);
  assert.equal(supervisor.inspect('run').inspection.runId, failed.runId);
});

test('project input validation precedes freshness checks and preserves prepared review and driver definitions', async t => {
  const { cwd, supervisor, id } = await ready(t);
  const task = supervisor.load(id), original = supervisor.project();
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'drift');
  const result = await supervisor.configure({ manifest, files: {} });
  assert.equal(result.code, 'INVALID_SPEC'); assert.match(result.message, /1 to 64/);
  assert.equal(supervisor.status().phase, 'READY');
  assert.equal(supervisor.load(id).prepared.digest, task.prepared.digest);
  assert.deepEqual(supervisor.project(), original);
  assert.equal((await supervisor.configure({ manifest, files: { 'driver.mjs': driver } })).code, 'CANDIDATE_CHANGED');
  assert.equal(supervisor.status().phase, 'DISCOVERY');
});

test('digest-only older tasks stay strict until explicit resume supplies an inventory; damaged manifests fail closed', async t => {
  const cwd = workspace(t), supervisor = new ExitCode(cwd);
  const id = ok(await supervisor.start('Finish the feature')).task;
  fs.unlinkSync(baselineFile(supervisor, id));
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'drift');
  const result = await supervisor.audit();
  assert.equal(result.code, 'CANDIDATE_CHANGED');
  assert.equal(result.diagnostics.baseline.inventoryUnavailable, true);
  assert.match(result.message, /historical inventory unavailable/);
  ok(await supervisor.resume(id));
  assert.ok(fs.existsSync(baselineFile(supervisor, id)));
  fs.writeFileSync(baselineFile(supervisor, id), '[]');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'another change');
  assert.equal((await supervisor.audit()).code, 'DAMAGED_STATE');
  assert.equal(fs.readFileSync(path.join(cwd, 'feature.txt'), 'utf8'), 'another change');
});

test('sealed resume neither adopts a new baseline nor discards an actionable acceptance issue', async t => {
  const { cwd, supervisor, id } = await ready(t); ok(await supervisor.approve());
  const task = supervisor.load(id), file = baselineFile(supervisor, id), before = fs.readFileSync(file, 'utf8');
  assert.equal((await supervisor.configure({ manifest, files: { 'driver.mjs': driver } })).code, 'SEALED');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'implementation edit');
  ok(await supervisor.resume(id));
  assert.equal(supervisor.load(id).baselineDigest, task.baselineDigest);
  assert.equal(supervisor.status().lastIssue.code, 'SEALED');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(supervisor.status().phase, 'SEALED');
  assert.ok(fs.existsSync(path.join(cwd, DEFAULT_STORE_DIR, 'state', 'tasks', id, 'sealed.json')));
});
