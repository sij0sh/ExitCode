/** Ordered root proof invariants. No planner or child sequence is involved. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as core from './exitcode-core.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { structuralReview } from './test/structural-review.mjs';

const sequence = [
  { objective: 'Establish the first artifact', verify: ['C1'] },
  { objective: 'Establish the second artifact', verify: ['C2'] },
  { objective: 'Finish the last artifact', verify: ['C3'] },
];
const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const write = (f, file, content) => fs.writeFileSync(path.join(f.cwd, file), content);
const criterion = (id, file) => ({ id, requirement: `The literal ${file} artifact contains done`,
  check: { recipe: { kind: 'custom_command', command: `observe:${file}` } },
  controls: { accept: { mutations: [{ kind: 'write_file', path: file, content: 'done' }] },
    reject: [{ mutations: [{ kind: 'write_file', path: file, content: 'pending' }] }] } });

function project(t, { allDone = false, review = structuralReview, order = sequence } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-sequence-'));
  for (const [file, content] of Object.entries({ first: allDone ? 'done' : 'pending', second: allDone ? 'done' : 'pending', last: 'done', stable: 'steady' }))
    fs.writeFileSync(path.join(cwd, file), content);
  t.after(() => { releasePreparation(cwd); fs.rmSync(cwd, { recursive: true, force: true }); });
  let now = 100;
  const calls = [];
  const exec = async (command, options) => {
    calls.push(command);
    const pass = command === 'preserve' ? read(options.cwd, 'stable') === 'steady' : read(options.cwd, command.slice(8)) === 'done';
    return { exit: pass ? 0 : 1, stdout: '', stderr: '', timedOut: false };
  };
  const io = core.makeIo(cwd, { exec, review, nowMs: () => now });
  const criteria = [criterion('C1', 'first'), criterion('C2', 'second'), criterion('C3', 'last'),
    { id: 'R1', requirement: 'The existing stable artifact is unchanged', type: 'regression', check: { recipe: { kind: 'custom_command', command: 'preserve' } } }];
  const drafted = core.draftNode(io, { goal: 'Complete the three literal artifacts in order', criteria, sequence: order });
  assert.equal(drafted.ok, true, JSON.stringify(drafted.errors));
  return { cwd, io, exec, calls, setNow: value => { now = value; } };
}
async function seal(f) {
  const prepared = await core.prepareNode(f.io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.deepEqual(prepared.baseline.outcomes.map(o => o.criterionId).sort(), ['C1', 'C2', 'C3', 'R1'], 'E0 validates future proof too');
  assert.equal((await core.sealNode(f.io, 'G1', { userApproval: 'Approve the ordered proof' })).ok, true);
  f.calls.length = 0;
  return core.loadRoot(f.io, 'G1');
}
const cursor = f => core.loadNodeState(f.io, 'G1').sequenceIndex;
async function evaluate(f, expectedCommands, node = 'G1') {
  f.calls.length = 0;
  const result = await core.evaluateNode(f.io, node);
  assert.deepEqual([...f.calls].sort(), [...expectedCommands].sort(), 'run precisely the cumulative horizon and all regressions');
  return result;
}
const firstProof = ['observe:first', 'preserve'];
const secondProof = ['observe:first', 'observe:second', 'preserve'];
const completeProof = ['observe:first', 'observe:second', 'observe:last', 'preserve'];

// This reviewer is scripted to exercise the existing assessment issue boundary,
// not to implement a deterministic ordering heuristic in the supervisor.
test('sequence: E0 reviews ordering only during assessment', async t => {
  for (const backwards of [false, true]) await t.test(backwards ? 'backwards' : 'valid', async t => {
    const order = backwards ? [sequence[1], sequence[0], sequence[2]] : sequence;
    const calls = [];
    const f = project(t, { order, review: async input => {
      calls.push(input);
      const response = await structuralReview(input);
      if (input.phase === 'derive') {
        assert.equal(Object.hasOwn(input, 'sequence'), false, 'independent outcome derivation is blind to order');
        assert.ok(input.criteria.every(c => !c.check && !c.controls));
      } else {
        assert.deepEqual(input.sequence, order, 'only the existing assessment sees order');
        if (backwards) response.issues.push({ code: 'SEQUENCE_INVALID', criterionId: 'C2', evidence: 'The second artifact proof requires the first artifact boundary assigned later' });
      }
      return response;
    } });
    const before = core.digestTree(f.cwd), result = await core.prepareNode(f.io);
    assert.deepEqual(calls.map(c => c.phase), ['derive', 'assess'], 'no extra planning model call');
    assert.equal(core.digestTree(f.cwd), before);
    assert.equal(result.ok, !backwards);
    if (backwards) {
      const issue = result.diagnostics.find(d => d.code === 'SEQUENCE_INVALID');
      assert.ok(issue, JSON.stringify(result.diagnostics));
      assert.equal(issue.repairability, 'agent');
      assert.equal(result.review, undefined);
      assert.equal(core.approveRoot(f.io).ok, false);
      assert.equal(f.calls.length, 0, 'semantic rejection precedes executable probes');
    } else {
      assert.deepEqual(result.baseline.outcomes.map(o => o.criterionId).sort(), ['C1', 'C2', 'C3', 'R1']);
      assert.equal(core.statusSnapshot(f.io).awaitingApproval, true);
    }
  });
});

test('sequence: root proof advances cumulatively and completes only at the final slice', async t => {
  for (const allDone of [false, true]) await t.test(allDone ? 'passing baseline' : 'incremental work', async t => {
    const f = project(t, { allDone });
    const approved = await seal(f), bytes = fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8');
    assert.equal(cursor(f), 0);
    assert.equal(core.loadRoot(f.io, 'G1').status, 'ACTIVE', 'a baseline never advances or completes');
    assert.deepEqual(core.loadNodeState(f.io, 'G1').lastResult.outcomes.map(o => o.criterionId).sort(), ['C1', 'R1'], 'future baseline evidence is not current repair feedback');
    if (!allDone) {
      const failed = await evaluate(f, firstProof);
      assert.equal(failed.vector, 'C1=FAIL R1=PASS');
      assert.equal(cursor(f), 0);
      write(f, 'first', 'done');
    }
    const first = await evaluate(f, firstProof);
    assert.equal(first.status, 'ACTIVE');
    assert.equal(first.cascade?.terminal ?? null, null);
    assert.equal(first.vector, 'C1=PASS R1=PASS');
    assert.equal(cursor(f), 1, 'one fresh prefix PASS advances exactly one slice');
    assert.equal(core.loadRoot(f.io, 'G1').outcome, undefined);
    if (!allDone) {
      const secondFailure = await evaluate(f, secondProof);
      assert.equal(secondFailure.vector, 'C1=PASS C2=FAIL R1=PASS');
      assert.equal(cursor(f), 1);
      write(f, 'second', 'done');
    }
    const second = await evaluate(f, secondProof);
    assert.equal(second.status, 'ACTIVE');
    assert.equal(second.cascade?.terminal ?? null, null);
    assert.equal(second.vector, 'C1=PASS C2=PASS R1=PASS');
    assert.equal(cursor(f), 2);
    const final = await evaluate(f, completeProof);
    assert.equal(final.status, 'PASS');
    assert.equal(final.vector, 'C1=PASS C2=PASS C3=PASS R1=PASS');
    assert.equal(final.cascade.terminal.status, 'PASS');
    assert.equal(final.cascade.terminal.outcome.candidateDigest, core.digestTree(f.cwd));
    const root = core.loadRoot(f.io, 'G1');
    assert.equal(root.consumedAttempts, allDone ? 0 : 2, 'cursor moves and unchanged reruns do not spend attempts');
    for (const key of ['approval', 'policy', 'executionStartedAt', 'deadlineAt']) assert.deepEqual(root[key], approved[key], key);
    assert.equal(fs.readFileSync(core.sealedFile(f.cwd, 'G1'), 'utf8'), bytes, 'acceptance remains fixed');
  });
});

test('sequence: recovery preserves the cursor and requires conclusive current proof', async t => {
  for (const mode of ['reload-pause', 'earlier-regression', 'regression-check', 'runner-error', 'ancestor-error', 'commit-deadline']) await t.test(mode, async t => {
    const f = project(t), approved = await seal(f);
    if (mode === 'ancestor-error') {
      const proposal = core.draftNode(f.io, { parentId: 'G1', target: 'C1', goal: 'Establish the helper artifact', criteria: [criterion('D1', 'helper')],
        reason: 'The helper reduces the first artifact proof', prerequisite: true, prerequisiteArtifact: 'helper' });
      assert.equal(proposal.ok, true);
      assert.equal((await core.sealNode(f.io, proposal.id)).ok, true);
      write(f, 'helper', 'done'); write(f, 'first', 'done');
      f.io.exec = async (command, options) => command === 'preserve'
        ? { exit: null, stdout: '', stderr: '', timedOut: false, error: 'parent runtime unavailable', errorCode: 'RUNNER_ERROR' } : f.exec(command, options);
      assert.equal((await core.evaluateNode(f.io, proposal.id)).pause.code, 'RUNNER_ERROR');
      assert.equal(cursor(f), 0);
      assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1', proposal.id]);
      assert.equal(core.loadNodeState(f.io, proposal.id).status, 'ACTIVE');
      f.io.exec = f.exec;
      assert.equal(core.resumeRoot(f.io).ok, true);
      const fresh = await core.evaluateNode(f.io, proposal.id);
      assert.equal(fresh.status, 'PASS', 'the child can close after conclusive parent refresh');
      assert.equal(fresh.cascade.terminal, null, 'a parent prefix is not complete root proof');
      assert.equal(cursor(f), 1);
      assert.deepEqual(core.loadRoot(f.io, 'G1').stack, ['G1']);
      assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1, 'retry does not double charge');
      return;
    }
    write(f, 'first', 'done');
    if (mode === 'commit-deadline') {
      f.io.nowMs = () => cursor(f) === 1 ? approved.deadlineAt : approved.executionStartedAt + 1000;
      const interrupted = await core.evaluateNode(f.io, 'G1');
      assert.equal(interrupted.pause?.code, 'DEADLINE_EXCEEDED', 'a deadline crossing during cursor commit is inconclusive');
      assert.equal(cursor(f), 0, 'an inconclusive commit cannot skip the first slice');
      assert.equal(core.loadRoot(f.io, 'G1').outcome, undefined);
      assert.equal(core.loadNodeState(f.io, 'G1').status, 'ACTIVE');
      f.io.nowMs = () => approved.deadlineAt;
      assert.equal(core.resumeRoot(f.io, { deadlineMinutes: 1 }).ok, true);
      assert.equal((await core.evaluateNode(f.io, 'G1')).status, 'ACTIVE');
      assert.equal(cursor(f), 1, 'recovery requires the same first horizon fresh');
      assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 1);
      return;
    }
    assert.equal((await evaluate(f, firstProof)).status, 'ACTIVE');
    assert.equal(cursor(f), 1);
    if (mode === 'reload-pause') {
      const fresh = core.makeIo(f.cwd, { exec: f.exec, nowMs: f.io.nowMs, expectedRootId: 'G1' });
      assert.equal(core.resumePreparation(fresh).ok, true);
      f.io = fresh;
      assert.equal(cursor(f), 1);
      assert.equal(core.pauseNode(f.io, { code: 'EXTERNAL_BLOCKED', reason: 'Restore the external prerequisite' }).status, 'PAUSED');
      assert.equal(cursor(f), 1);
      assert.equal(core.resumeRoot(f.io).ok, true);
      assert.equal((await evaluate(f, secondProof)).status, 'ACTIVE');
      assert.equal(cursor(f), 1, 'a failing horizon stays current after resume');
    } else if (mode === 'runner-error') {
      write(f, 'second', 'done');
      f.io.exec = async (command, options) => command === 'preserve'
        ? { exit: null, stdout: '', stderr: '', timedOut: false, error: 'runtime unavailable', errorCode: 'RUNNER_ERROR' } : f.exec(command, options);
      assert.equal((await core.evaluateNode(f.io, 'G1')).pause.code, 'RUNNER_ERROR');
      assert.equal(cursor(f), 1);
      assert.equal(core.loadRoot(f.io, 'G1').outcome, undefined);
      f.io.exec = f.exec;
      assert.equal(core.resumeRoot(f.io).ok, true);
      assert.equal((await evaluate(f, secondProof)).status, 'ACTIVE');
      assert.equal(cursor(f), 2, 'a conclusive retry advances once, not to root PASS');
      assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 2);
    } else {
      write(f, 'second', 'done');
      write(f, mode === 'earlier-regression' ? 'first' : 'stable', 'broken');
      const restored = await core.evaluateNode(f.io, 'G1');
      assert.deepEqual(restored.regressedRestored, [mode === 'earlier-regression' ? 'C1' : 'R1']);
      assert.equal(cursor(f), 1, 'restoration does not advance or reset order');
      assert.equal(read(f.cwd, 'first'), 'done');
      assert.equal(read(f.cwd, 'stable'), 'steady');
      assert.equal(read(f.cwd, 'second'), 'pending');
      assert.equal(core.loadRoot(f.io, 'G1').consumedAttempts, 2, 'the rejected attempt remains spent');
      assert.equal((await evaluate(f, secondProof)).status, 'ACTIVE');
      assert.equal(cursor(f), 1);
    }
    const current = core.loadRoot(f.io, 'G1');
    for (const key of ['policy', 'approval', 'executionStartedAt', 'deadlineAt']) assert.deepEqual(current[key], approved[key], key);
    assert.deepEqual(current.stack, ['G1']);
    assert.equal(current.outcome, undefined);
  });
});
