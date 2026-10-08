/** Recovery regressions use disposable workspaces and injected independent reviewers. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import * as hostCore from './exitcode-core.mjs';
import { fixedTestRuntime } from './test/runtime.mjs';
import { callReview, reviewRepository } from './exitcode-quality.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { sandboxCommand, scanCapabilities, evaluatorEnvironment, captureEvaluatorAssets, verifyEvaluatorAssets, restoreEvaluatorAssets } from './exitcode-evaluator.mjs';
import { structuralReview } from './test/structural-review.mjs';

const core={...hostCore,makeIo:(cwd,overrides={})=>hostCore.makeIo(cwd,{fingerprintRuntime:fixedTestRuntime,...overrides})};

const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const run = (exit, extra = {}) => ({ exit, stdout: '', stderr: '', timedOut: false, ...extra });
const criterion = (id, file, commands = false) => ({
  id, requirement: `The literal ${file} artifact contains done`,
  check: commands ? { command: `observe:${file}` } : { recipe: { kind: 'file_contains', path: file, value: 'done' } },
  controls: {
    accept: { mutations: [{ kind: 'write_file', path: file, content: 'done' }] },
    reject: [{ mutations: [{ kind: 'write_file', path: file, content: 'pending' }] }],
  },
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
  const criteria = [criterion('C1', 'feature', commands), {
    id: 'C2', requirement: 'The existing feature artifact remains present', type: 'regression',
    check: commands ? { command: 'preserve' } : { recipe: { kind: 'file_exists', path: 'feature' } },
  }];
  const args = { goal: 'Complete the literal feature artifact', criteria, policy,
    intentAtoms: criteria.map(c => ({ id: c.id, outcome: c.requirement, criteria: [c.id] })), ...draft };
  assert.equal(core.draftNode(io, args).ok, true);
  t.after(() => { releasePreparation(cwd); fs.rmSync(parent, { recursive: true, force: true }); });
  return { cwd, parent, io, args, exec, setNow: value => { now = value; } };
}
async function seal(f) {
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.equal(core.approveRoot(f.io).ok, true);
  const result = await core.sealNode(f.io, 'G1');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return core.loadRoot(f.io, 'G1');
}
async function child(f) {
  const result = core.draftNode(f.io, {
    parentId: 'G1', target: 'C1', goal: 'Create the literal helper artifact', criteria: [criterion('D1', 'helper', true)],
    reason: 'The helper is a prerequisite for C1', prerequisite: true, prerequisiteArtifact: 'helper',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const sealed = await core.sealNode(f.io, result.id);
  assert.equal(sealed.ok, true, JSON.stringify(sealed.errors));
  return result.id;
}
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await sleep(5); }
  throw Error('test operation did not start');
}

// The global clock is authority only after the root's successful execution seal.
test('recovery: discovery, independent review, E0 and human approval have no execution countdown', async t => {
  const f = project(t);
  const created = core.loadRoot(f.io, 'G1').createdAt;
  f.setNow(created + 14 * 86400000);
  f.io.review = async (input, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    f.setNow(created + (input.phase === 'derive' ? 21 : 28) * 86400000);
    return structuralReview(input);
  };
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true);
  assert.equal(core.REVIEW_TIMEOUT_MS, null);
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, null);
  assert.equal(core.statusSnapshot(f.io).expired, false);
  f.setNow(created + 60 * 86400000);
  assert.equal(core.approveRoot(f.io).ok, true);
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, null);
  assert.equal((await core.sealNode(f.io, 'G1')).ok, true);
  const root = core.loadRoot(f.io, 'G1');
  assert.equal(root.createdAt, created);
  assert.equal(root.executionStartedAt, created + 60 * 86400000);
  assert.equal(root.deadlineAt, root.executionStartedAt + root.policy.deadlineMinutes * 60000);
  const restarted = core.makeIo(f.cwd, { nowMs: f.io.nowMs, exec: f.exec, review: structuralReview });
  assert.equal(core.resumeRoot(restarted).ok, true);
  assert.equal(core.loadRoot(restarted, 'G1').deadlineAt, root.deadlineAt);
});

test('recovery: model review has no fixed thirty-second ceiling and still honors cancellation', async () => {
  assert.deepEqual(await callReview(() => ({ reviewed: true }), {}, { timeoutMs: 60000 }), { reviewed: true });
  const controller = new AbortController();
  let invoked = false;
  controller.abort();
  await assert.rejects(callReview(() => { invoked = true; return {}; }, {}, { signal: controller.signal }), e => e.code === 'CANCELLED');
  assert.equal(invoked, false);
  await assert.rejects(callReview(() => new Promise(() => {}), {}, { timeoutMs: 5 }), e => e.code === 'REVIEW_TIMEOUT');
});

test('recovery: bounded transport retries retain diagnostics and do not spend evaluator quality proposals', async t => {
  const f = project(t);
  let calls = 0;
  f.io.review = async input => {
    if (++calls <= 2) throw Object.assign(Error('provider returned 429'), { status: 429 });
    return structuralReview(input);
  };
  const result = await core.prepareNode(f.io);
  assert.equal(result.ok, true);
  const metrics = core.loadNodeState(f.io, 'G1').evaluatorMetrics;
  assert.equal(calls, 4);
  assert.equal(metrics.reviewCalls, 4);
  assert.equal(metrics.reviewCompleted, 2);
  assert.equal(metrics.transportRetries, 2);
  assert.equal(metrics.e0Attempts, 1);
  assert.equal(result.stages.filter(s => s.stage === 'review-transport').length, 2);
});

test('recovery: configuration failures pause the same unsealed root without retries or quality charges', async t => {
  const f = project(t);
  let calls = 0;
  f.io.review = async () => { calls++; throw Object.assign(Error('400 incompatible request'), { status: 400 }); };
  const failed = await core.prepareNode(f.io);
  assert.equal(failed.status, 'PAUSED');
  assert.equal(failed.pause.code, 'REVIEW_CONFIGURATION');
  assert.equal(calls, 1);
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, 0);
  assert.equal(core.loadNodeState(f.io, 'G1').preparing, undefined);
  assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1']);
  assert.equal(core.draftNode(f.io, f.args).ok, false);
  assert.equal(core.resumeRoot(f.io).ok, true);
  const revision = core.draftNode(f.io, { ...f.args, revise: 'G1', policy: { deadlineMinutes: 90, evalTimeoutSeconds: 1200 } });
  assert.equal(revision.ok, true);
  assert.equal(revision.deadlineAt, null);
  f.io.review = structuralReview;
  assert.equal((await core.prepareNode(f.io)).ok, true);
  assert.equal(core.approveRoot(f.io).ok, true);
});

test('recovery: failed negative execution is inconclusive and cannot spend substantive construction budget', async t => {
  const f = project(t, { commands: true });
  let negatives = 0;
  f.io.exec = async (command, options) => command === 'observe:feature' && read(options.cwd, 'feature') === 'pending'
    ? (negatives++, run(null, { error: 'temporary runner failure', errorCode: 'RUNNER_ERROR' })) : f.exec(command, options);
  const result = await core.prepareNode(f.io);
  assert.equal(result.status, 'PAUSED');
  assert.ok(result.diagnostics.some(d => d.code === 'RUNNER_ERROR'));
  assert.ok(negatives > 0);
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, 0);
  assert.equal(core.approveRoot(f.io).ok, false);
  assert.equal(core.loadBundle(f.io, 'G1'), null);
});

test('recovery: harmless stdout timing variation does not make repeated acceptance nondeterministic', async t => {
  const f = project(t, { commands: true });
  let count = 0;
  f.io.exec = async (command, options) => ({ ...await f.exec(command, options), stdout: `elapsed ${++count}ms` });
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, 1);
});

test('recovery: runtime IO failure always clears preparation ownership', async t => {
  const f = project(t, { files: { node_modules: 'not a directory' } });
  const result = await core.prepareNode(f.io);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.pause.code, 'ENOTDIR');
  assert.equal(core.loadNodeState(f.io, 'G1').preparing, undefined);
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, 0);
  assert.equal(fs.existsSync(core.storePaths(f.cwd).operation), false);
  // User cancellation releases pre-seal preservation before the authorized host repair.
  core.releaseBaseline(f.cwd);
  fs.rmSync(path.join(f.cwd, 'node_modules'));
  assert.equal(core.resumeRoot(f.io).ok, true);
  assert.equal((await core.prepareNode(f.io)).ok, true);
});

test('recovery: runner ERROR preserves useful edits, approval, stack and persisted candidate reservation', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  const bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8');
  const approval = core.loadRoot(f.io, 'G1').approval;
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  f.io.exec = async (command, options) => command === 'preserve' ? run(null, { error: 'isolated runner unavailable' }) : f.exec(command, options);
  const failed = await core.evaluateNode(f.io);
  assert.equal(failed.status, 'PAUSED');
  assert.equal(read(f.cwd, 'feature'), 'done');
  const paused = core.loadRoot(f.io, 'G1');
  assert.deepEqual(paused.stack, ['G1']);
  assert.deepEqual(paused.approval, approval);
  assert.equal(paused.consumedAttempts, 1);
  assert.equal(core.loadNodeState(f.io, 'G1').attempts, 1);
  assert.equal(paused.candidateReservation.candidateDigest, core.digestTree(f.cwd));
  core.ensureBaseline(f.io);
  assert.equal(read(f.cwd, 'feature'), 'done', 'a sealed pause never restores an old preparation candidate');
  f.io.exec = f.exec;
  assert.equal(core.resumeRoot(f.io).operation, 'evaluate');
  const result = await core.evaluateNode(f.io);
  assert.equal(result.status, 'PASS');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes);
});

test('recovery: interrupted snapshot or identity IO cannot regain an implementation attempt', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  let first = true;
  f.io.exec = async (command, options) => {
    const result = await f.exec(command, options);
    if (first) { first = false; execFileSync('mkfifo', [path.join(f.cwd, 'pipe')]); }
    return result;
  };
  assert.equal((await core.evaluateNode(f.io)).status, 'PAUSED');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
  assert.equal(core.loadNodeState(f.io, 'G1').attempts, 1);
  assert.equal(read(f.cwd, 'feature'), 'done');
  fs.rmSync(path.join(f.cwd, 'pipe'));
  f.io.exec = f.exec;
  assert.equal(core.resumeRoot(f.io).ok, true);
  assert.equal((await core.evaluateNode(f.io)).status, 'PASS');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
});

test('recovery: unchanged verification cannot dispatch or PASS after the shared deadline', async t => {
  const f = project(t, { done: true, commands: true, policy: { deadlineMinutes: 1 } });
  const sealed = await seal(f);
  f.setNow(sealed.deadlineAt);
  let executions = 0;
  f.io.exec = async () => { executions++; return run(0); };
  const result = await core.evaluateNode(f.io);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.pause.code, 'DEADLINE_EXCEEDED');
  assert.equal(executions, 0);
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 0);
  assert.equal(core.resumeRoot(f.io).ok, false);
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, sealed.deadlineAt);
});

test('recovery: explicit execution grants add authority without editing policy, contract or original accounting', async t => {
  const f = project(t, { commands: true, policy: { deadlineMinutes: 1, maxTotalAttempts: 1 } });
  const original = await seal(f);
  const bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8');
  f.setNow(original.deadlineAt + 1000);
  assert.equal((await core.evaluateNode(f.io)).status, 'PAUSED');
  const paused = core.loadRoot(f.io, 'G1');
  for (const grant of [{ deadlineMinutes: -1 }, { deadlineMinutes: Infinity }, { maxTotalAttempts: 0.5 }]) {
    assert.equal(core.resumeRoot(f.io, grant).ok, false);
    assert.deepEqual(core.loadRoot(f.io, 'G1'), paused);
  }
  assert.equal(core.resumeRoot(f.io, { deadlineMinutes: 2, maxTotalAttempts: 2 }).ok, true);
  const resumed = core.loadRoot(f.io, 'G1');
  assert.deepEqual(resumed.policy, original.policy);
  assert.deepEqual(resumed.approval, original.approval);
  assert.equal(resumed.createdAt, original.createdAt);
  assert.equal(resumed.executionStartedAt, original.executionStartedAt);
  assert.equal(resumed.deadlineAt, original.deadlineAt + 1000 + 120000);
  assert.equal(resumed.attemptLimit, 3);
  assert.equal(resumed.executionGrants[0].approvedBy, 'user');
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes);
});

test('recovery: in-flight checks use remaining time and discard deadline-crossing PASS', async t => {
  const f = project(t, { commands: true, policy: { deadlineMinutes: 1 } });
  const root = await seal(f);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  f.setNow(root.executionStartedAt + 1000);
  const timeouts = [];
  f.io.exec = async (command, options) => {
    timeouts.push(options.timeoutMs);
    f.setNow(root.deadlineAt);
    return f.exec(command, options);
  };
  assert.equal((await core.evaluateNode(f.io)).status, 'PAUSED');
  assert.deepEqual(timeouts, [59000]);
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
  assert.equal(core.loadNodeState(f.io, 'G1').status, 'ACTIVE');
});

test('recovery: check timeout remains explicit under corrected root policy and inherited child policy', async t => {
  const f = project(t);
  const criteria = structuredClone(f.args.criteria);
  criteria[0].check.timeoutSeconds = 600;
  const revision = core.draftNode(f.io, { ...f.args, revise: 'G1', criteria, policy: { evalTimeoutSeconds: 900 } });
  assert.equal(revision.ok, true);
  assert.equal(revision.draft.criteria[0].check.timeoutSeconds, 600);
  await seal(f);
  const check = criterion('D1', 'helper'); check.check.timeoutSeconds = 600;
  const proposal = core.draftNode(f.io, { parentId: 'G1', target: 'C1', goal: 'Create helper', criteria: [check],
    reason: 'Prerequisite', prerequisite: true, prerequisiteArtifact: 'helper' });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.draft.criteria[0].check.timeoutSeconds, 600);
  assert.equal(core.loadRoot(f.io, 'G1').policy.evalTimeoutSeconds, 900);
});

test('recovery: child model review uses the existing root deadline without restarting it', async t => {
  const f = project(t, { policy: { deadlineMinutes: 1 } });
  const root = await seal(f);
  const proposal = core.draftNode(f.io, { parentId: 'G1', target: 'C1', goal: 'Create helper', criteria: [criterion('D1', 'helper')],
    reason: 'Prerequisite', prerequisite: true, prerequisiteArtifact: 'helper' });
  assert.equal(proposal.ok, true);
  f.io.review = async input => { f.setNow(root.deadlineAt); return structuralReview(input); };
  const result = await core.sealNode(f.io, proposal.id);
  assert.equal(result.status, 'PAUSED');
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, root.deadlineAt);
  assert.equal(core.loadRoot(f.io, 'G1').executionStartedAt, root.executionStartedAt);
  assert.equal(core.loadNodeState(f.io, proposal.id).sealAttempts, 0);
  assert.equal(core.loadNodeState(f.io, proposal.id).preparing, undefined);
});

test('recovery: cancellation before dispatch produces no acceptance or attempt charge', async t => {
  const f = project(t, { commands: true });
  await seal(f);
  const controller = new AbortController(); controller.abort(); f.io.signal = controller.signal;
  let invoked = 0; f.io.exec = async () => { invoked++; return run(0); };
  const result = await core.evaluateNode(f.io);
  assert.equal(result.ok, false);
  assert.equal(invoked, 0);
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 0);
  assert.notEqual(core.loadRoot(f.io, 'G1').status, 'PASS');
  const direct = await sandboxCommand('printf unsafe > touched', { cwd: f.cwd, signal: controller.signal });
  assert.equal(direct.errorCode, 'CANCELLED');
  assert.equal(read(f.cwd, 'touched'), null);
});

test('recovery: sandbox cancellation awaits process-group close before returning and stops descendants', async t => {
  const f = project(t);
  const controller = new AbortController();
  const pending = core.runCheck({ id: 'C1', check: { command: 'printf ready > started; (sleep 0.3; printf late > late) & sleep 10' } },
    sandboxCommand, f.cwd, 5000, { signal: controller.signal });
  await waitFor(() => read(f.cwd, 'started') === 'ready');
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'ERROR');
  assert.equal(result.errorCode, 'CANCELLED');
  await sleep(400);
  assert.equal(read(f.cwd, 'late'), null);
});

test('recovery: nested executable cancellation finishes before deleting fixtures or releasing workspace ownership', async t => {
  const f = project(t, { commands: true });
  const command = 'printf ready > started; sleep 10; test "$(cat feature)" = done';
  f.args.criteria[0].check.command = command;
  assert.equal(core.draftNode(f.io, { ...f.args, revise: 'G1' }).ok, true);
  f.io.exec = async (cmd, options) => cmd === command ? run(read(options.cwd, 'feature') === 'done' ? 0 : 1) : f.exec(cmd, options);
  await seal(f);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  const controller = new AbortController(); f.io.signal = controller.signal; f.io.exec = sandboxCommand;
  const pending = core.evaluateNode(f.io);
  await waitFor(() => fs.readdirSync(f.parent).some(name => name.startsWith('exitcode-fresh-') &&
    fs.existsSync(path.join(f.parent, name, 'started'))));
  assert.equal(core.resumePreparation(core.makeIo(f.cwd)).code, 'OPERATION_BUSY');
  assert.ok(fs.existsSync(core.storePaths(f.cwd).operation));
  controller.abort();
  assert.equal((await pending).status, 'PAUSED');
  assert.deepEqual(fs.readdirSync(f.parent), ['project']);
  assert.equal(fs.existsSync(core.storePaths(f.cwd).operation), false);
  assert.equal(read(f.cwd, 'feature'), 'done');
});

test('recovery: session startup and resume cannot clear another live operation', async t => {
  const f = project(t);
  let complete;
  f.io.review = async input => input.phase === 'derive' ? new Promise(resolve => { complete = () => resolve(structuralReview(input)); }) : structuralReview(input);
  const pending = core.prepareNode(f.io);
  await waitFor(() => typeof complete === 'function');
  const other = core.makeIo(f.cwd, { expectedRootId: 'G1' });
  assert.equal(core.resumePreparation(other).code, 'OPERATION_BUSY');
  assert.equal(core.resumeRoot(other).code, 'OPERATION_BUSY');
  assert.equal(core.loadNodeState(f.io, 'G1').preparing, true);
  assert.equal(core.draftNode(other, { ...f.args, revise: 'G1' }).code, 'OPERATION_BUSY');
  complete();
  assert.equal((await pending).ok, true);
  assert.equal(core.loadNodeState(f.io, 'G1').preparing, undefined);
});

test('recovery: transcript root ownership prevents mutations of another workspace root', async t => {
  const f = project(t);
  const before = core.loadRoot(f.io, 'G1');
  const wrong = core.makeIo(f.cwd, { expectedRootId: 'G2', review: structuralReview });
  assert.equal(core.draftNode(wrong, { ...f.args, revise: 'G1' }).code, 'ROOT_MISMATCH');
  assert.equal(core.resumePreparation(wrong).code, 'ROOT_MISMATCH');
  assert.equal((await core.prepareNode(wrong)).code, 'ROOT_MISMATCH');
  assert.deepEqual(core.loadRoot(f.io, 'G1'), before);
});

test('recovery: inconclusive ancestor evaluation cannot record child PASS or pop the active stack', async t => {
  const f = project(t, { commands: true }); await seal(f);
  const id = await child(f);
  const bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8');
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done'); fs.writeFileSync(path.join(f.cwd, 'helper'), 'done');
  f.io.exec = async (command, options) => command === 'observe:feature' ? run(null, { error: 'parent runtime unavailable' }) : f.exec(command, options);
  assert.equal((await core.evaluateNode(f.io, id)).status, 'PAUSED');
  assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1', id]);
  assert.equal(core.loadNodeState(f.io, id).status, 'ACTIVE');
  assert.equal(read(f.cwd, 'feature'), 'done');
  f.io.exec = f.exec;
  assert.equal(core.resumeRoot(f.io).ok, true);
  const result = await core.evaluateNode(f.io, id);
  assert.equal(result.cascade.terminal.status, 'PASS');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
  assert.equal(result.cascade.terminal.outcome.candidateDigest, core.digestTree(f.cwd));
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes);
});

test('recovery: losing the exact pre-child checkpoint cannot fall back to an unrelated restore', async t => {
  const f = project(t, { commands: true }); await seal(f);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'partial');
  const id = await child(f);
  const leaf = core.loadNodeState(f.io, id), parent = core.loadNodeState(f.io, 'G1');
  const cp = parent.checkpoints.find(c => c.id === leaf.preChildCheckpointId);
  fs.rmSync(cp.dir, { recursive: true });
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done'); fs.writeFileSync(path.join(f.cwd, 'helper'), 'done');
  const result = await core.blockNode(f.io, id, { reason: 'This child is not a viable path', code: 'NO_PATH' });
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.pause.code, 'RESTORATION_FAILED');
  assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1', id]);
  assert.equal(core.loadNodeState(f.io, id).status, 'ACTIVE');
  assert.equal(read(f.cwd, 'feature'), 'done');
});

test('recovery: checkpoint metadata never overwrites a candidate manifest and unsafe restoration validates before deletion', t => {
  const f = project(t, { files: { 'manifest.json': '{"candidate":true}\n', '.pi/settings.json': '{"candidate":true}\n' } });
  const directory = path.join(f.cwd, '.exitcode/tmp/snapshot');
  const snap = core.snapshotTree(f.cwd, directory);
  assert.equal(snap.ok, true);
  assert.equal(read(directory, 'tree/manifest.json'), '{"candidate":true}\n');
  fs.writeFileSync(path.join(f.cwd, 'manifest.json'), '{}');
  assert.equal(core.restoreTree(f.cwd, directory, snap.manifest).ok, true);
  assert.equal(read(f.cwd, 'manifest.json'), '{"candidate":true}\n');
  fs.writeFileSync(path.join(f.cwd, 'later'), 'keep until validation succeeds');
  const invalid = structuredClone(snap.manifest); invalid.files[0].path = '../outside';
  assert.throws(() => core.restoreTree(f.cwd, directory, invalid), /unsafe candidate path/);
  assert.equal(read(f.cwd, 'later'), 'keep until validation succeeds');
  fs.writeFileSync(path.join(directory, 'tree/feature'), 'corrupt');
  assert.throws(() => core.restoreTree(f.cwd, directory, snap.manifest), /checkpoint bytes changed/);
  assert.equal(read(f.cwd, 'later'), 'keep until validation succeeds');
});

test('recovery: fresh completion never certifies a candidate changed after copying', async t => {
  const f = project(t, { commands: true }); await seal(f);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  let first = true;
  f.io.exec = async (command, options) => {
    const result = await f.exec(command, options);
    if (first) { first = false; fs.writeFileSync(path.join(f.cwd, 'feature'), 'pending'); }
    return result;
  };
  const result = await core.evaluateNode(f.io);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.pause.code, 'CANDIDATE_MUTATED');
  assert.equal(core.loadRoot(f.io, 'G1').outcome, undefined);
  assert.equal(read(f.cwd, 'feature'), 'pending');
});

test('recovery: acceptance helpers and mandatory test inventory freeze while imported product source stays mutable', async t => {
  const source = "import{readFileSync}from'node:fs';export const value=()=>readFileSync('feature','utf8');";
  const helper = "import{value}from'../src/product.mjs';process.exit(value()==='done'?0:1);";
  const f = project(t, { files: { 'src/product.mjs': source, 'checks/accept.mjs': helper, 'tests/mandatory.test.mjs': 'export const mandatory=true;' } });
  f.args.criteria[0].check = { command: 'node checks/accept.mjs', assets: ['checks/accept.mjs'] };
  assert.equal(core.draftNode(f.io, { ...f.args, revise: 'G1' }).ok, true);
  f.io.exec = sandboxCommand;
  await seal(f);
  const bundle = core.loadBundle(f.io, 'G1');
  assert.ok(bundle.assets.files.some(f => f.path === 'checks/accept.mjs'));
  assert.ok(!bundle.assets.files.some(f => f.path === 'src/product.mjs'));
  fs.writeFileSync(path.join(f.cwd, 'src/product.mjs'), source + '\n// Permitted product implementation change.\n');
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  fs.writeFileSync(path.join(f.cwd, 'checks/accept.mjs'), 'process.exit(0);');
  const drift = await core.evaluateNode(f.io);
  assert.equal(drift.status, 'PAUSED');
  assert.equal(drift.pause.code, 'EVALUATOR_DRIFT');
  fs.writeFileSync(path.join(f.cwd, 'checks/accept.mjs'), helper);
  assert.equal(core.resumeRoot(f.io).ok, true);
  fs.writeFileSync(path.join(f.cwd, 'tests/new.test.mjs'), 'export const newCase=true;');
  assert.equal((await core.evaluateNode(f.io)).pause.code, 'EVALUATOR_DRIFT');
  fs.rmSync(path.join(f.cwd, 'tests/new.test.mjs'));
  assert.equal(core.resumeRoot(f.io).ok, true);
  const final=await core.evaluateNode(f.io);assert.equal(final.status,'PASS',JSON.stringify(final));
});

test('recovery: frozen evaluator package closure stays immutable while approved product dependencies change', async t => {
  const packageText = JSON.stringify({ dependencies: { product: '1' }, devDependencies: { verifier: '1' } });
  const f = project(t, { draft: { mutableDependencies: true }, files: {
    'package.json': packageText,
    'node_modules/product/package.json': '{"name":"product","version":"1"}',
    'node_modules/product/value.mjs': 'export const value=1;',
    'node_modules/verifier/package.json': '{"name":"verifier","version":"1","dependencies":{"shared":"1"},"optionalDependencies":{"optional":"1"}}',
    'node_modules/verifier/check.mjs': 'export const check=1;',
    'node_modules/shared/package.json': '{"name":"shared","version":"1"}',
    'node_modules/shared/assert.mjs': 'export const assertion=1;',
  } });
  await seal(f);
  const bundle = core.loadBundle(f.io, 'G1');
  assert.ok(bundle.assets.files.some(f => f.path === 'node_modules/shared/assert.mjs'));
  assert.ok(!bundle.assets.files.some(f => f.path === 'node_modules/product/value.mjs'));
  fs.writeFileSync(path.join(f.cwd, 'node_modules/product/value.mjs'), 'export const value=2;');
  fs.writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({ dependencies: { product: '2' }, devDependencies: { verifier: '1' } }));
  verifyEvaluatorAssets(f.cwd, bundle.assetsDirectory, bundle.assets);
  fs.writeFileSync(path.join(f.cwd, 'node_modules/shared/assert.mjs'), 'export const assertion=0;');
  assert.equal((await core.evaluateNode(f.io)).pause.code, 'EVALUATOR_DRIFT');
  fs.writeFileSync(path.join(f.cwd, 'node_modules/shared/assert.mjs'), 'export const assertion=1;');
  assert.equal(core.resumeRoot(f.io).ok, true);
  // An optional dependency becoming available changes evaluator resolution.
  fs.mkdirSync(path.join(f.cwd, 'node_modules/optional'));
  fs.writeFileSync(path.join(f.cwd, 'node_modules/optional/package.json'), '{"name":"optional"}');
  assert.equal((await core.evaluateNode(f.io)).pause.code, 'EVALUATOR_DRIFT');
  fs.rmSync(path.join(f.cwd, 'node_modules/optional'), { recursive: true });
  assert.equal(core.resumeRoot(f.io).ok, true);
  fs.writeFileSync(path.join(f.cwd, 'feature'), 'done');
  const final=await core.evaluateNode(f.io);assert.equal(final.status,'PASS',JSON.stringify(final));
  assert.equal(core.loadRoot(f.io, 'G1').outcome.candidateDigest, core.digestTree(f.cwd));
});

test('recovery: dependency declarations, executable runtime packages and frozen configuration cannot drift', t => {
  const f = project(t, { draft: { mutableDependencies: true }, files: {
    'package.json': '{"dependencies":{"cli":"1"},"devDependencies":{"review":"1"},"scripts":{"test":"node --test"}}',
    'node_modules/cli/package.json': '{"name":"cli","bin":{"cli":"bin.mjs"}}',
    'node_modules/cli/bin.mjs': 'process.exit(0);',
    'node_modules/review/package.json': '{"name":"review"}',
  } });
  fs.mkdirSync(path.join(f.cwd, 'node_modules/.bin'));
  fs.symlinkSync('../cli/bin.mjs', path.join(f.cwd, 'node_modules/.bin/cli'));
  const draft = core.readJson(core.draftFile(f.cwd, 'G1')).draft;
  const directory = path.join(f.cwd, '.exitcode/assets/test');
  const assets = captureEvaluatorAssets(f.cwd, draft, directory);
  assert.ok(assets.files.some(f => f.path === 'node_modules/cli/bin.mjs'));
  verifyEvaluatorAssets(f.cwd, directory, assets);
  fs.writeFileSync(path.join(f.cwd, 'package.json'), '{"dependencies":{"cli":"2"},"devDependencies":{"review":"2"},"scripts":{"test":"node --test"}}');
  assert.throws(() => verifyEvaluatorAssets(f.cwd, directory, assets), /acceptance asset changed: package.json/);
});

test('recovery: explicitly referenced hidden plans enter bounded independent review without credential files', t => {
  const f = project(t, { files: { '.agents/artifacts/plan.md': 'Required outcome: the literal feature artifact must contain done.',
    '.agents/artifacts/secret.md': 'api_key=supersecretcredential123456', '.agents/artifacts/extra.md': 'not selected' } });
  const repository = reviewRepository(f.cwd, scanCapabilities(f.cwd), f.args.criteria,
    ['.agents/artifacts/plan.md', '.agents/artifacts/secret.md']);
  assert.ok(repository.files.some(f => f.path === '.agents/artifacts/plan.md'));
  assert.ok(!repository.files.some(f => /secret|extra/.test(f.path)));
  assert.ok(repository.missingSpecifications.includes('.agents/artifacts/secret.md'));
});

test('recovery: safe unsealed legacy migration preserves history and demands fresh validated approval', async t => {
  const f = project(t);
  const root = core.loadRoot(f.io, 'G1'), node = core.loadNodeState(f.io, 'G1');
  delete root.clockVersion; delete root.executionStartedAt;
  root.deadlineAt = 99; root.status = 'BLOCKED'; root.stack = [];
  root.outcome = { code: 'BUDGET_EXHAUSTED', reason: 'Old drafting clock elapsed' };
  root.approval = { approvedBy: 'user', digest: 'old approval' }; root.policyLocked = true;
  node.status = 'BLOCKED'; node.evaluatorMetrics.e0Attempts = 2;
  core.saveRoot(f.io, root); core.saveNodeState(f.io, node);
  const index = core.loadIndex(f.cwd); index.activeRootId = null; core.saveIndex(f.cwd, index);
  const resumed = core.resumeRoot(f.io, { rootId: 'G1' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.migrated, true);
  const current = core.loadRoot(f.io, 'G1');
  assert.equal(current.legacyTiming.deadlineAt, 99);
  assert.equal(current.deadlineAt, null);
  assert.equal(current.createdAt, root.createdAt);
  assert.equal(current.approval, undefined);
  assert.equal(core.loadNodeState(f.io, 'G1').evaluatorMetrics.e0Attempts, 2);
  assert.equal(core.approveRoot(f.io).ok, false);
  assert.equal((await core.prepareNode(f.io)).ok, true);
  assert.equal(core.approveRoot(f.io).ok, true);
});

test('recovery: legacy sealed roots retain their deadline and refuse missing frozen command evidence', async t => {
  const f = project(t, { commands: true }); await seal(f);
  const root = core.loadRoot(f.io, 'G1'), node = core.loadNodeState(f.io, 'G1'), bundle = core.loadBundle(f.io, 'G1');
  delete root.clockVersion; delete root.executionStartedAt;
  root.policy.evalTimeoutSeconds = 120;
  bundle.version = 1; delete bundle.assets; delete bundle.assetsDirectory; delete bundle.integrityDigest;
  delete node.sealedBundleDigest;
  core.saveRoot(f.io, root); core.saveNodeState(f.io, node); core.writeJsonAtomic(core.sealedFile(f.cwd, 'G1'), bundle);
  const bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8');
  const failed = await core.evaluateNode(f.io);
  assert.equal(failed.pause.code, 'LEGACY_EVIDENCE_MISSING');
  assert.match(failed.pause.reason, /superseding approved contract is required/);
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, root.deadlineAt);
  assert.equal(core.resumeRoot(f.io).migrated, false);
  assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes);
});

test('recovery: legacy builtin acceptance keeps original local limits and dependency-excluding attempt accounting', async t => {
  const f = project(t, { done: true }); await seal(f);
  const root = core.loadRoot(f.io, 'G1'), node = core.loadNodeState(f.io, 'G1'), bundle = core.loadBundle(f.io, 'G1');
  delete root.clockVersion; delete root.executionStartedAt; root.policy.evalTimeoutSeconds = 120;
  bundle.version = 1; delete bundle.assets; delete bundle.assetsDirectory; delete bundle.integrityDigest;
  delete node.sealedBundleDigest;
  core.saveRoot(f.io, root); core.saveNodeState(f.io, node); core.writeJsonAtomic(core.sealedFile(f.cwd, 'G1'), bundle);
  assert.equal((await core.evaluateNode(f.io)).status, 'PASS');
  assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 0);
  assert.equal(core.loadRoot(f.io, 'G1').deadlineAt, root.deadlineAt);
  assert.deepEqual(core.loadRoot(f.io, 'G1').policy, root.policy);
  assert.deepEqual(evaluatorEnvironment(f.cwd,f.io), bundle.env);
});


test('recovery: a slow model review survives the former thirty-second deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let started=false,nested;
  const pending=callReview((_input,{signal})=>{started=true;nested=signal;return new Promise(resolve=>setTimeout(()=>resolve({reviewed:true}),45000));},{});
  await Promise.resolve();assert.equal(started,true);
  t.mock.timers.tick(45000);
  assert.deepEqual(await pending,{reviewed:true});
  assert.equal(nested.aborted,false);
});

test('recovery: an in-flight absolute deadline stops isolated descendants before returning evidence', async t => {
  const f=project(t),deadlineAt=Date.now()+80;
  const result=await core.runCheck({id:'C1',check:{command:'(sleep 0.3; printf late > late) & sleep 10'}},sandboxCommand,f.cwd,5000,{deadlineAt});
  assert.equal(result.status,'ERROR');assert.equal(result.errorCode,'DEADLINE_EXCEEDED');
  await sleep(400);assert.equal(read(f.cwd,'late'),null);
});

test('recovery: expiry while committing a verdict cannot record root or child PASS', async t => {
  const f=project(t,{commands:true});const before=await seal(f);
  fs.writeFileSync(path.join(f.cwd,'feature'),'done');
  f.io.nowMs=()=>core.loadNodeState(f.io,'G1').status==='PASS'?before.deadlineAt:before.executionStartedAt;
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PAUSED');assert.equal(result.pause.code,'DEADLINE_EXCEEDED');
  assert.equal(core.loadNodeState(f.io,'G1').status,'ACTIVE');
  assert.deepEqual(core.loadRoot(f.io,'G1').stack,['G1']);
  assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);
  assert.equal(core.loadIndex(f.cwd).activeRootId,'G1');
});

test('recovery: reload recovers an interrupted provisional verdict and requires fresh root evaluation', async t => {
  const f=project(t,{commands:true});await seal(f);
  const root=core.loadRoot(f.io,'G1'),node=core.loadNodeState(f.io,'G1'),index=core.loadIndex(f.cwd);
  root.closingStack=['G1'];root.stack=[];root.status='PASS';root.outcome={candidateDigest:core.digestTree(f.cwd)};
  node.status='PASS';index.activeRootId=null;
  core.saveRoot(f.io,root);core.saveNodeState(f.io,node);core.saveIndex(f.cwd,index);
  assert.equal(core.terminalStale(f.io,'G1').stale,true);
  const recovered=core.resumePreparation(core.makeIo(f.cwd,{expectedRootId:'G1'}));
  assert.equal(recovered.status,'PAUSED');assert.equal(recovered.pause.code,'INTERRUPTED');
  assert.deepEqual(core.loadRoot(f.io,'G1').stack,['G1']);
  assert.equal(core.loadNodeState(f.io,'G1').status,'ACTIVE');
  assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);
  assert.equal(core.resumeRoot(f.io).ok,true);
  fs.writeFileSync(path.join(f.cwd,'feature'),'done');
  assert.equal((await core.evaluateNode(f.io)).status,'PASS');
});

test('recovery: a missing confidential declared specification prevents reviewer dispatch and approval', async t => {
  const f=project(t,{draft:{specificationPaths:['.agents/artifacts/missing.md']}});
  let calls=0;f.io.review=async input=>{calls++;return structuralReview(input);};
  const result=await core.prepareNode(f.io);
  assert.equal(result.status,'PAUSED');assert.equal(result.pause.code,'SPECIFICATION_UNAVAILABLE');
  assert.equal(calls,0);assert.equal(core.approveRoot(f.io).ok,false);
  assert.equal(core.loadNodeState(f.io,'G1').evaluatorMetrics.e0Attempts,0);
});


test('recovery: a rehashed or downgraded sealed bundle cannot replace its supervisor identity', async t => {
  const f=project(t);await seal(f);const bundle=core.loadBundle(f.io,'G1');
  bundle.version=1;bundle.contract.criteria[0].check.recipe.value='pending';
  bundle.digest=core.sha256Hex(core.stableStringify(bundle.contract));delete bundle.integrityDigest;
  core.writeJsonAtomic(core.sealedFile(f.cwd,'G1'),bundle);
  const result=await core.evaluateNode(f.io);
  assert.equal(result.status,'PAUSED');assert.equal(result.pause.code,'EVALUATOR_DRIFT');
  assert.equal(core.loadRoot(f.io,'G1').outcome,undefined);
});

test('recovery: runtime-aware duplicate suppression allows a changed environment but not identical blocked evidence', () => {
  const args={root:{policy:core.DEFAULT_POLICY,consumedAttempts:0,deadlineAt:1000},
    parentState:{status:'ACTIVE',lastCandidateDigest:'candidate'},parentResult:{outcomes:[{criterionId:'C1',status:'FAIL'}]},
    target:'C1',goal:'Create helper',nowMs:0,environmentIdentity:'old',
    siblings:[{status:'BLOCKED',id:'G1.1',target:'C1',goalDigest:core.fingerprintGoal('Create helper'),candidateDigest:'candidate',environmentIdentity:'old'}]};
  assert.equal(core.childGates(args).ok,false);
  assert.equal(core.childGates({...args,environmentIdentity:'new'}).ok,true);
});

test('recovery: root-side candidate reservations survive partial node persistence without double charging', async t => {
  const f=project(t,{commands:true});await seal(f);fs.writeFileSync(path.join(f.cwd,'feature'),'done');
  f.io.exec=async()=>run(null,{error:'interrupted runner'});
  assert.equal((await core.evaluateNode(f.io)).status,'PAUSED');
  const node=core.loadNodeState(f.io,'G1');node.attempts=0;delete node.reservedCandidateDigest;delete node.reservedAccountingDigest;
  core.saveNodeState(f.io,node);f.io.exec=f.exec;
  assert.equal(core.resumeRoot(f.io).ok,true);
  assert.equal((await core.evaluateNode(f.io)).status,'PASS');
  assert.equal(core.loadRoot(f.io,'G1').consumedAttempts,1);
  assert.equal(core.loadNodeState(f.io,'G1').attempts,1);
});

test('recovery: incomplete output cannot prove the absence of forbidden stdout', async t => {
  const f=project(t);
  const result=await core.runCheck({id:'C1',check:{command:'observe',expect:{stdoutNotContains:['unsafe']}}},
    async()=>run(0,{stdout:'only the retained tail',truncated:true}),f.cwd,1000);
  assert.equal(result.status,'ERROR');assert.equal(result.errorCode,'OUTPUT_INCOMPLETE');
});


test('recovery: acceptance configuration restoration refuses symlinks and replaces hard links without external writes', t => {
  const f=project(t,{draft:{mutableDependencies:true},files:{'package.json':'{"name":"product","dependencies":{"runtime":"1"}}'}});
  const directory=path.join(f.cwd,'.exitcode/assets/restore-test');
  const assets=captureEvaluatorAssets(f.cwd,core.readJson(core.draftFile(f.cwd,'G1')).draft,directory);
  const outside=path.join(f.parent,'outside-package.json'),bytes='{"name":"external","dependencies":{"runtime":"2"}}\n';
  const packageFile=path.join(f.cwd,'package.json');
  fs.writeFileSync(outside,bytes);fs.unlinkSync(packageFile);fs.symlinkSync(outside,packageFile);
  assert.throws(()=>restoreEvaluatorAssets(f.cwd,directory,assets),/symlink path forbidden/);
  assert.equal(fs.readFileSync(outside,'utf8'),bytes);
  fs.unlinkSync(packageFile);fs.linkSync(outside,packageFile);
  assert.equal(fs.statSync(packageFile).ino,fs.statSync(outside).ino);
  restoreEvaluatorAssets(f.cwd,directory,assets);
  assert.equal(fs.readFileSync(outside,'utf8'),bytes);
  assert.notEqual(fs.statSync(packageFile).ino,fs.statSync(outside).ino);
  assert.deepEqual(JSON.parse(read(f.cwd,'package.json')),{name:'product',dependencies:{runtime:'2'}});
  verifyEvaluatorAssets(f.cwd,directory,assets);
});

test('recovery: checkpoint restoration replaces a changed hard link without writing outside the candidate', t => {
  const f=project(t),directory=path.join(f.cwd,'.exitcode/tmp/hard-link-checkpoint');
  const snap=core.snapshotTree(f.cwd,directory);assert.equal(snap.ok,true);
  const outside=path.join(f.parent,'outside-feature'),bytes='external';
  fs.writeFileSync(outside,bytes);fs.unlinkSync(path.join(f.cwd,'feature'));fs.linkSync(outside,path.join(f.cwd,'feature'));
  assert.equal(core.restoreTree(f.cwd,directory,snap.manifest).ok,true);
  assert.equal(read(f.cwd,'feature'),'pending');
  assert.equal(fs.readFileSync(outside,'utf8'),bytes);
  assert.notEqual(fs.statSync(path.join(f.cwd,'feature')).ino,fs.statSync(outside).ino);
});


test('recovery: declared acceptance asset paths pin the same bytes with dot and trailing-slash spelling', t => {
  const f=project(t,{files:{'checks/accept.mjs':'process.exit(1);','checks/fixtures/expected.json':'{"valid":true}'}});
  const draft=core.readJson(core.draftFile(f.cwd,'G1')).draft;
  draft.criteria[0].check.assets=['./checks//accept.mjs','./checks/fixtures/'];
  const directory=path.join(f.cwd,'.exitcode/assets/canonical-test');
  const assets=captureEvaluatorAssets(f.cwd,draft,directory);
  assert.ok(assets.files.some(file=>file.path==='checks/accept.mjs'));
  assert.ok(assets.files.some(file=>file.path==='checks/fixtures/expected.json'));
  assert.ok(assets.directories.includes('checks/fixtures'));
  verifyEvaluatorAssets(f.cwd,directory,assets);
  fs.writeFileSync(path.join(f.cwd,'checks/accept.mjs'),'process.exit(0);');
  assert.throws(()=>verifyEvaluatorAssets(f.cwd,directory,assets),/acceptance asset changed: checks\/accept.mjs/);
});


test('recovery: isolated recipe runners preserve shared deadline priority over the clamped watchdog', async t => {
  const f=project(t),deadlineAt=Date.now()+80;
  const result=await core.runCheck({id:'C1',check:{recipe:{kind:'custom_command',command:'sleep 10'}}},sandboxCommand,f.cwd,5000,{deadlineAt});
  assert.equal(result.status,'ERROR');assert.equal(result.errorCode,'DEADLINE_EXCEEDED');
});
