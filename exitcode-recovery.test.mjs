/** Crash, reload, cancellation, and compatibility boundaries. See INVARIANTS.md. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import * as core from './exitcode-core.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { sandboxCommand, evaluatorEnvironment } from './exitcode-evaluator.mjs';
import { structuralReview } from './test/structural-review.mjs';

const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const run = (exit, extra = {}) => ({ exit, stdout: '', stderr: '', timedOut: false, ...extra });
const criterion = (id, file, commands = false) => ({
  id, requirement: `The literal ${file} artifact contains done`,
  check: commands ? { command: `observe:${file}` } : { recipe: { kind: 'file_contains', path: file, value: 'done' } },
  ...(commands ? { controls: { accept: { mutations: [{ kind: 'write_file', path: file, content: 'done' }] },
    reject: [{ mutations: [{ kind: 'write_file', path: file, content: 'pending' }] }] } } : {}),
});
function project(t, { done = false, commands = false, files = {}, policy = {}, draft = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-recovery-'));
  const cwd = path.join(parent, 'project');
  for (const [rel, content] of Object.entries({ feature: done ? 'done' : 'pending', ...files })) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  }
  let now = 100;
  const exec = async (command, options) => {
    if (command.startsWith('observe:')) return run(read(options.cwd, command.slice(8)) === 'done' ? 0 : 1);
    if (command === 'preserve') return run(read(options.cwd, 'feature') === null ? 1 : 0);
    throw Error(`unexpected executable: ${command}`);
  };
  const io = core.makeIo(cwd, { review: structuralReview, exec, nowMs: () => now });
  const criteria = [criterion('C1', 'feature', commands), { id: 'C2', requirement: 'The existing feature artifact remains present', type: 'regression',
    check: commands ? { command: 'preserve' } : { recipe: { kind: 'file_exists', path: 'feature' } } }];
  const args = { goal: 'Complete the literal feature artifact', criteria, policy, ...draft };
  assert.equal(core.draftNode(io, args).ok, true);
  t.after(() => { releasePreparation(cwd); fs.rmSync(parent, { recursive: true, force: true }); });
  return { cwd, parent, io, args, exec, setNow: value => { now = value; } };
}
async function seal(f) {
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.equal(core.approveRoot(f.io).ok, true);
  assert.equal((await core.sealNode(f.io, 'G1')).ok, true);
  return core.loadRoot(f.io, 'G1');
}
async function child(f) {
  const result = core.draftNode(f.io, { parentId: 'G1', target: 'C1', goal: 'Create the literal helper artifact', criteria: [criterion('D1', 'helper', true)],
    reason: 'The helper is a prerequisite for C1', prerequisite: true, prerequisiteArtifact: 'helper' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal((await core.sealNode(f.io, result.id)).ok, true);
  return result.id;
}
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await sleep(5); }
  throw Error('test operation did not start');
}
const done = f => fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');

test('recovery: infrastructure faults during preparation pause without spending evaluator quality budget', async t => {
  // Retryable transport errors are retried a bounded number of times.
  const retried = project(t);
  let calls = 0;
  retried.io.review = async input => { if (++calls <= 2) throw Object.assign(Error('provider returned 429'), { status: 429 }); return structuralReview(input); };
  const ok = await core.prepareNode(retried.io);
  assert.equal(ok.ok, true);
  assert.deepEqual([calls, ok.stages.filter(s => s.stage === 'review-transport').length], [4, 2]);
  assert.equal(core.loadNodeState(retried.io, 'G1').evaluatorMetrics.transportRetries, 2);
  for (const [label, setup, code] of [
    ['configuration', f => { f.io.review = async () => { throw Object.assign(Error('400 incompatible request'), { status: 400 }); }; }, 'REVIEW_CONFIGURATION'],
    ['runner', f => { f.io.exec = async (command, options) => command === 'observe:feature' && read(options.cwd, 'feature') === 'pending'
      ? run(null, { error: 'temporary runner failure', errorCode: 'RUNNER_ERROR' }) : f.exec(command, options); }, 'RUNNER_ERROR'],
    ['runtime IO', f => { fs.writeFileSync(path.join(f.cwd, 'node_modules'), 'not a directory'); core.releaseBaseline(f.cwd); }, 'ENOTDIR'],
    ['missing specification', f => { assert.equal(core.draftNode(f.io, { ...f.args, revise: 'G1', specificationPaths: ['.agents/artifacts/missing.md'] }).ok, true); }, 'SPECIFICATION_UNAVAILABLE'],
  ]) {
    const f = project(t, { commands: true });
    setup(f);
    const failed = await core.prepareNode(f.io);
    assert.equal(failed.status, 'PAUSED', label);
    assert.equal(failed.pause.code, code, label);
    const node = core.loadNodeState(f.io, 'G1');
    assert.equal(node.evaluatorMetrics.e0Attempts, 0, label);
    assert.equal(node.preparing, undefined, label);
    assert.equal(fs.existsSync(core.storePaths(f.cwd).operation), false, label);
    assert.equal(core.approveRoot(f.io).ok, false, label);
  }
});

test('recovery: interrupted preparation never restores approval and its evaluator charge persists', async t => {
  const f = project(t);
  assert.equal((await core.prepareNode(f.io)).ok, true);
  const node = core.loadNodeState(f.io, 'G1'), attempts = node.evaluatorMetrics.e0Attempts;
  node.preparing = true;
  core.saveNodeState(f.io, node);
  core.resumePreparation(f.io);
  assert.equal(core.loadNodeState(f.io, 'G1').phase, 'EVALUATOR_PREPARATION');
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, attempts);
  assert.equal(core.approveRoot(f.io).ok, false);
});

test('recovery: live operations and transcript root ownership cannot be cleared or bypassed', async t => {
  const f = project(t);
  let complete;
  f.io.review = async input => input.phase === 'derive' ? new Promise(resolve => { complete = () => resolve(structuralReview(input)); }) : structuralReview(input);
  const pending = core.prepareNode(f.io);
  await waitFor(() => typeof complete === 'function');
  const other = core.makeIo(f.cwd, { expectedRootId: 'G1' });
  assert.equal(core.resumePreparation(other).code, 'OPERATION_BUSY');
  assert.equal(core.resumeRoot(other).code, 'OPERATION_BUSY');
  assert.equal(core.draftNode(other, { ...f.args, revise: 'G1' }).code, 'OPERATION_BUSY');
  complete();
  assert.equal((await pending).ok, true);
  const before = core.loadRoot(f.io, 'G1');
  const wrong = core.makeIo(f.cwd, { expectedRootId: 'G2', review: structuralReview });
  assert.equal(core.draftNode(wrong, { ...f.args, revise: 'G1' }).code, 'ROOT_MISMATCH');
  assert.equal(core.resumePreparation(wrong).code, 'ROOT_MISMATCH');
  assert.equal((await core.prepareNode(wrong)).code, 'ROOT_MISMATCH');
  assert.deepEqual(core.loadRoot(f.io, 'G1'), before);
});

test('recovery: cancellation stops isolated descendants before fixtures or ownership are released', async t => {
  const f = project(t, { commands: true });
  const command = 'printf ready > started; sleep 10; test "$(cat feature)" = done';
  f.args.criteria[0].check.command = command;
  assert.equal(core.draftNode(f.io, { ...f.args, revise: 'G1' }).ok, true);
  f.io.exec = async (cmd, options) => cmd === command ? run(read(options.cwd, 'feature') === 'done' ? 0 : 1) : f.exec(cmd, options);
  await seal(f);
  // Cancelled before dispatch: nothing runs and nothing is charged.
  const cancelled = new AbortController(); cancelled.abort();
  let invoked = 0;
  const idle = core.makeIo(f.cwd, { exec: async () => { invoked++; return run(0); }, signal: cancelled.signal, nowMs: f.io.nowMs });
  assert.equal((await core.evaluateNode(idle)).ok, false);
  assert.equal(invoked, 0);
  assert.equal((await sandboxCommand('printf unsafe > touched', { cwd: f.cwd, signal: cancelled.signal })).errorCode, 'CANCELLED');
  assert.equal(read(f.cwd, 'touched'), null);
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 0);
  if (core.loadRoot(f.io, 'G1').status === 'PAUSED') assert.equal(core.resumeRoot(f.io).ok, true);
  // Cancelled in flight: the process group stops before fixtures and the workspace lock are released.
  done(f);
  const controller = new AbortController();
  const live = core.makeIo(f.cwd, { exec: sandboxCommand, signal: controller.signal, nowMs: f.io.nowMs, review: structuralReview });
  const pending = core.evaluateNode(live);
  await waitFor(() => fs.readdirSync(f.parent).some(name => name.startsWith('exitcode-fresh-') && fs.existsSync(path.join(f.parent, name, 'started'))));
  assert.equal(core.resumePreparation(core.makeIo(f.cwd)).code, 'OPERATION_BUSY');
  controller.abort();
  assert.equal((await pending).status, 'PAUSED');
  assert.deepEqual(fs.readdirSync(f.parent), ['project']);
  assert.equal(fs.existsSync(core.storePaths(f.cwd).operation), false);
  assert.equal(read(f.cwd, 'feature'), 'done');
  // Direct runner cancellation and absolute deadlines also wait for descendants.
  for (const [label, options, code] of [['abort', null, 'CANCELLED'], ['deadline', { deadlineAt: Date.now() + 80 }, 'DEADLINE_EXCEEDED']]) {
    const abort = new AbortController();
    const check = core.runCheck({ id: 'C1', check: { command: 'printf ready > started-check; (sleep 0.3; printf late > late) & sleep 10' } },
      sandboxCommand, f.cwd, 5000, options ?? { signal: abort.signal });
    if (!options) { await waitFor(() => read(f.cwd, 'started-check') === 'ready'); abort.abort(); }
    const result = await check;
    assert.equal(result.errorCode, code, label);
    await sleep(400);
    assert.equal(read(f.cwd, 'late'), null, label);
  }
  const recipe = await core.runCheck({ id: 'C1', check: { recipe: { kind: 'custom_command', command: 'sleep 10' } } }, sandboxCommand, f.cwd, 5000, { deadlineAt: Date.now() + 80 });
  assert.equal(recipe.errorCode, 'DEADLINE_EXCEEDED', 'shared deadline outranks the clamped watchdog');
});

test('recovery: inconclusive evaluation preserves work, approval, stack, and a single attempt charge', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  const bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), approval = core.loadRoot(f.io, 'G1').approval;
  done(f);
  f.io.exec = async (command, options) => command === 'preserve' ? run(null, { error: 'isolated runner unavailable' }) : f.exec(command, options);
  assert.equal((await core.evaluateNode(f.io)).status, 'PAUSED');
  const paused = core.loadRoot(f.io, 'G1');
  assert.deepEqual([paused.stack, paused.approval, paused.consumedAttempts], [['G1'], approval, 1]);
  assert.equal(paused.candidateReservation.candidateDigest, core.digestTree(f.cwd));
  core.ensureBaseline(f.io);
  assert.equal(read(f.cwd, 'feature'), 'done', 'a sealed pause never restores an old preparation candidate');
  // Partial node persistence cannot double charge the reserved candidate.
  const node = core.loadNodeState(f.io, 'G1');
  node.attempts = 0; delete node.reservedCandidateDigest; delete node.reservedAccountingDigest;
  core.saveNodeState(f.io, node);
  f.io.exec = f.exec;
  assert.equal(core.resumeRoot(f.io).operation, 'evaluate');
  assert.equal((await core.evaluateNode(f.io)).status, 'PASS');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes);
  // Interrupted identity IO cannot regain an attempt either.
  const g = project(t, { commands: true });
  await seal(g);
  done(g);
  let first = true;
  g.io.exec = async (command, options) => { const result = await g.exec(command, options); if (first) { first = false; execFileSync('mkfifo', [path.join(g.cwd, 'pipe')]); } return result; };
  assert.equal((await core.evaluateNode(g.io)).status, 'PAUSED');
  fs.rmSync(path.join(g.cwd, 'pipe'));
  g.io.exec = g.exec;
  assert.equal(core.resumeRoot(g.io).ok, true);
  assert.equal((await core.evaluateNode(g.io)).status, 'PASS');
  assert.equal(core.loadRoot(g.io, 'G1').consumedAttempts, 1);
  // A candidate changed after copying is never certified.
  const h = project(t, { commands: true });
  await seal(h);
  done(h);
  let once = true;
  h.io.exec = async (command, options) => { const result = await h.exec(command, options); if (once) { once = false; fs.writeFileSync(path.join(h.cwd, 'feature'), 'pending'); } return result; };
  const mutated = await core.evaluateNode(h.io);
  assert.equal(mutated.pause.code, 'CANDIDATE_MUTATED');
  assert.equal(core.loadRoot(h.io, 'G1').outcome, undefined);
});

test('recovery: an inconclusive ancestor or a missing pre-child checkpoint keeps the child path open', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  const id = await child(f);
  done(f); fs.writeFileSync(path.join(f.cwd, 'helper'), 'done');
  f.io.exec = async (command, options) => command === 'observe:feature' ? run(null, { error: 'parent runtime unavailable' }) : f.exec(command, options);
  assert.equal((await core.evaluateNode(f.io, id)).status, 'PAUSED');
  assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1', id]);
  assert.equal(core.loadNodeState(f.io, id).status, 'ACTIVE');
  f.io.exec = f.exec;
  assert.equal(core.resumeRoot(f.io).ok, true);
  const result = await core.evaluateNode(f.io, id);
  assert.equal(result.cascade.terminal.status, 'PASS');
  assert.equal(result.cascade.terminal.outcome.candidateDigest, core.digestTree(f.cwd));
  const g = project(t, { commands: true });
  await seal(g);
  fs.writeFileSync(path.join(g.cwd, 'feature'), 'partial');
  const lost = await child(g);
  const cp = core.loadNodeState(g.io, 'G1').checkpoints.find(c => c.id === core.loadNodeState(g.io, lost).preChildCheckpointId);
  fs.rmSync(cp.dir, { recursive: true });
  done(g);
  const blocked = await core.blockNode(g.io, lost, { reason: 'This child is not a viable path', code: 'NO_PATH' });
  assert.equal(blocked.pause.code, 'RESTORATION_FAILED');
  assert.deepEqual(core.loadRoot(g.io, 'G1').stack, ['G1', lost]);
  assert.equal(read(g.cwd, 'feature'), 'done', 'no fallback to an unrelated restore');
});

test('recovery: checkpoint metadata and restoration validate before deleting anything', t => {
  const f = project(t, { files: { 'manifest.json': '{"candidate":true}\n', '.pi/settings.json': '{"candidate":true}\n' } });
  const directory = path.join(f.cwd, '.exitcode/tmp/snapshot');
  const snap = core.snapshotTree(f.cwd, directory);
  assert.equal(read(directory, 'tree/manifest.json'), '{"candidate":true}\n');
  fs.writeFileSync(path.join(f.cwd, 'manifest.json'), '{}');
  assert.equal(core.restoreTree(f.cwd, directory, snap.manifest).ok, true);
  assert.equal(read(f.cwd, 'manifest.json'), '{"candidate":true}\n');
  fs.writeFileSync(path.join(f.cwd, 'later'), 'keep until validation succeeds');
  const invalid = structuredClone(snap.manifest); invalid.files[0].path = '../outside';
  assert.throws(() => core.restoreTree(f.cwd, directory, invalid), /unsafe candidate path/);
  fs.writeFileSync(path.join(directory, 'tree/feature'), 'corrupt');
  assert.throws(() => core.restoreTree(f.cwd, directory, snap.manifest), /checkpoint bytes changed/);
  assert.equal(read(f.cwd, 'later'), 'keep until validation succeeds');
});

test('recovery: deadline crossings never yield PASS, and only explicit user grants add authority', async t => {
  // Unchanged verification cannot dispatch after the deadline.
  const expired = project(t, { done: true, commands: true, policy: { deadlineMinutes: 1 } });
  const sealed = await seal(expired);
  expired.setNow(sealed.deadlineAt);
  let executions = 0;
  expired.io.exec = async () => { executions++; return run(0); };
  assert.equal((await core.evaluateNode(expired.io)).pause.code, 'DEADLINE_EXCEEDED');
  assert.equal(executions, 0);
  // In-flight checks use remaining time; a PASS that crosses the deadline is discarded.
  const crossing = project(t, { commands: true, policy: { deadlineMinutes: 1 } });
  const root = await seal(crossing);
  done(crossing);
  crossing.setNow(root.executionStartedAt + 1000);
  const timeouts = [];
  crossing.io.exec = async (command, options) => { timeouts.push(options.timeoutMs); crossing.setNow(root.deadlineAt); return crossing.exec(command, options); };
  assert.equal((await core.evaluateNode(crossing.io)).status, 'PAUSED');
  assert.deepEqual(timeouts, [59000]);
  assert.equal(core.loadNodeState(crossing.io, 'G1').status, 'ACTIVE');
  // Expiry while committing the verdict cannot record PASS.
  const commit = project(t, { commands: true });
  const before = await seal(commit);
  done(commit);
  commit.io.nowMs = () => core.loadNodeState(commit.io, 'G1').status === 'PASS' ? before.deadlineAt : before.executionStartedAt;
  assert.equal((await core.evaluateNode(commit.io)).pause.code, 'DEADLINE_EXCEEDED');
  assert.equal(core.loadRoot(commit.io, 'G1').outcome, undefined);
  assert.equal(core.loadIndex(commit.cwd).activeRootId, 'G1');
  // Grants are positive, explicit, and never edit policy, approval, contract, or the original clock.
  const granted = project(t, { commands: true, policy: { deadlineMinutes: 1, maxTotalAttempts: 1 } });
  const original = await seal(granted);
  const bytes = fs.readFileSync(core.sealedFile(granted.cwd, 'G1'), 'utf8');
  granted.setNow(original.deadlineAt + 1000);
  assert.equal((await core.evaluateNode(granted.io)).status, 'PAUSED');
  const paused = core.loadRoot(granted.io, 'G1');
  assert.equal(core.resumeRoot(granted.io).ok, false);
  for (const grant of [{ deadlineMinutes: -1 }, { deadlineMinutes: Infinity }, { maxTotalAttempts: 0.5 }]) {
    assert.equal(core.resumeRoot(granted.io, grant).ok, false);
    assert.deepEqual(core.loadRoot(granted.io, 'G1'), paused);
  }
  assert.equal(core.resumeRoot(granted.io, { deadlineMinutes: 2, maxTotalAttempts: 2 }).ok, true);
  const resumed = core.loadRoot(granted.io, 'G1');
  for (const key of ['policy', 'approval', 'createdAt', 'executionStartedAt']) assert.deepEqual(resumed[key], original[key], key);
  assert.equal(resumed.deadlineAt, original.deadlineAt + 1000 + 120000);
  assert.equal(resumed.attemptLimit, 3);
  assert.equal(resumed.executionGrants[0].approvedBy, 'user');
  assert.equal(fs.readFileSync(core.sealedFile(granted.cwd, 'G1'), 'utf8'), bytes);
  // Child review after sealing shares the root deadline without restarting it.
  const shared = project(t, { policy: { deadlineMinutes: 1 } });
  const sharedRoot = await seal(shared);
  const proposal = core.draftNode(shared.io, { parentId: 'G1', target: 'C1', goal: 'Create helper', criteria: [criterion('D1', 'helper')],
    reason: 'Prerequisite', prerequisite: true, prerequisiteArtifact: 'helper' });
  shared.io.review = async input => { shared.setNow(sharedRoot.deadlineAt); return structuralReview(input); };
  assert.equal((await core.sealNode(shared.io, proposal.id)).status, 'PAUSED');
  assert.equal(core.loadRoot(shared.io, 'G1').deadlineAt, sharedRoot.deadlineAt);
  assert.equal(core.loadNodeState(shared.io, proposal.id).sealAttempts, 0);
});

test('recovery: reload recovers an interrupted provisional verdict and requires fresh root evaluation', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  const root = core.loadRoot(f.io, 'G1'), node = core.loadNodeState(f.io, 'G1'), index = core.loadIndex(f.cwd);
  root.closingStack = ['G1']; root.stack = []; root.status = 'PASS'; root.outcome = { candidateDigest: core.digestTree(f.cwd) };
  node.status = 'PASS'; index.activeRootId = null;
  core.saveRoot(f.io, root); core.saveNodeState(f.io, node); core.saveIndex(f.cwd, index);
  assert.equal(core.terminalStale(f.io, 'G1').stale, true);
  const recovered = core.resumePreparation(core.makeIo(f.cwd, { expectedRootId: 'G1' }));
  assert.equal(recovered.pause.code, 'INTERRUPTED');
  assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1']);
  assert.equal(core.loadRoot(f.io, 'G1').outcome, undefined);
  assert.equal(core.resumeRoot(f.io).ok, true);
  done(f);
  assert.equal((await core.evaluateNode(f.io)).status, 'PASS');
});

test('recovery: legacy roots and bundles migrate safely or fail closed', async t => {
  // An unsealed legacy root keeps its history but needs fresh validated approval.
  const draft = project(t);
  const root = core.loadRoot(draft.io, 'G1'), node = core.loadNodeState(draft.io, 'G1');
  delete root.clockVersion; delete root.executionStartedAt;
  Object.assign(root, { deadlineAt: 99, status: 'BLOCKED', stack: [], outcome: { code: 'BUDGET_EXHAUSTED', reason: 'Old drafting clock elapsed' },
    approval: { approvedBy: 'user', digest: 'old approval' }, policyLocked: true });
  node.status = 'BLOCKED'; node.evaluatorMetrics.e0Attempts = 2;
  core.saveRoot(draft.io, root); core.saveNodeState(draft.io, node);
  const index = core.loadIndex(draft.cwd); index.activeRootId = null; core.saveIndex(draft.cwd, index);
  const resumed = core.resumeRoot(draft.io, { rootId: 'G1' });
  assert.equal(resumed.migrated, true);
  const current = core.loadRoot(draft.io, 'G1');
  assert.deepEqual([current.legacyTiming.deadlineAt, current.deadlineAt, current.approval], [99, null, undefined]);
  assert.equal(core.loadNodeState(draft.io, 'G1').evaluatorMetrics.e0Attempts, 2);
  assert.equal(core.approveRoot(draft.io).ok, false);
  assert.equal((await core.prepareNode(draft.io)).ok, true);
  assert.equal(core.approveRoot(draft.io).ok, true);
  // Legacy sealed bundles: built-in acceptance can finish under its original limits; command evidence without frozen assets cannot.
  const legacy = async (options) => {
    const f = project(t, options);
    await seal(f);
    const r = core.loadRoot(f.io, 'G1'), n = core.loadNodeState(f.io, 'G1'), bundle = core.loadBundle(f.io, 'G1');
    delete r.clockVersion; delete r.executionStartedAt; r.policy.evalTimeoutSeconds = 120;
    bundle.version = 1; delete bundle.assets; delete bundle.assetsDirectory; delete bundle.integrityDigest; delete n.sealedBundleDigest;
    core.saveRoot(f.io, r); core.saveNodeState(f.io, n); core.writeJsonAtomic(core.sealedFile(f.cwd, 'G1'), bundle);
    return { f, root: r, bundle };
  };
  const builtin = await legacy({ done: true });
  assert.equal((await core.evaluateNode(builtin.f.io)).status, 'PASS');
  assert.equal(core.loadRoot(builtin.f.io, 'G1').consumedAttempts, 0);
  assert.deepEqual(core.loadRoot(builtin.f.io, 'G1').policy, builtin.root.policy);
  assert.deepEqual(evaluatorEnvironment(builtin.f.cwd), builtin.bundle.env);
  const command = await legacy({ commands: true });
  const bytes = fs.readFileSync(core.sealedFile(command.f.cwd, 'G1'), 'utf8');
  const failed = await core.evaluateNode(command.f.io);
  assert.equal(failed.pause.code, 'LEGACY_EVIDENCE_MISSING');
  assert.match(failed.pause.reason, /superseding approved contract is required/);
  assert.equal(core.loadRoot(command.f.io, 'G1').deadlineAt, command.root.deadlineAt);
  assert.equal(core.resumeRoot(command.f.io).migrated, false);
  assert.equal(fs.readFileSync(core.sealedFile(command.f.cwd, 'G1'), 'utf8'), bytes);
  // A rehashed or downgraded bundle cannot replace its supervisor identity.
  const forged = project(t);
  await seal(forged);
  const bundle = core.loadBundle(forged.io, 'G1');
  bundle.version = 1; bundle.contract.criteria[0].check.recipe.value = 'pending';
  bundle.digest = core.sha256Hex(core.stableStringify(bundle.contract)); delete bundle.integrityDigest;
  core.writeJsonAtomic(core.sealedFile(forged.cwd, 'G1'), bundle);
  assert.equal((await core.evaluateNode(forged.io)).pause.code, 'EVALUATOR_DRIFT');
  // Blocked-child duplicate suppression is runtime aware.
  const args = { root: { policy: core.DEFAULT_POLICY, consumedAttempts: 0, deadlineAt: 1000 }, parentState: { status: 'ACTIVE', lastCandidateDigest: 'candidate' },
    parentResult: { outcomes: [{ criterionId: 'C1', status: 'FAIL' }] }, target: 'C1', goal: 'Create helper', nowMs: 0, environmentIdentity: 'old',
    siblings: [{ status: 'BLOCKED', id: 'G1.1', target: 'C1', goalDigest: core.fingerprintGoal('Create helper'), candidateDigest: 'candidate', environmentIdentity: 'old' }] };
  assert.equal(core.childGates(args).ok, false);
  assert.equal(core.childGates({ ...args, environmentIdentity: 'new' }).ok, true);
});
