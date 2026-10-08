/** Crash, reload, cancellation, and store-generation boundaries. See INVARIANTS.md. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import * as core from './exitcode-core.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { sandboxCommand } from './exitcode-evaluator.mjs';
import { structuralReview } from './test/structural-review.mjs';

const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
const run = (exit, extra = {}) => ({ exit, stdout: '', stderr: '', timedOut: false, ...extra });
const custom = command => ({ recipe: { kind: 'custom_command', command } });
const criterion = (id, file, commands = false) => ({
  id, requirement: `The literal ${file} artifact contains done`,
  check: commands ? custom(`observe:${file}`) : { recipe: { kind: 'file_contains', path: file, value: 'done' } },
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
    check: commands ? custom('preserve') : { recipe: { kind: 'file_exists', path: 'feature' } } }];
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

test('recovery: infrastructure faults during root preparation remain editable without spending evaluator quality budget', async t => {
  // Retryable transport errors are retried a bounded number of times.
  const retried = project(t);
  let calls = 0;
  retried.io.review = async input => { if (++calls <= 2) throw Object.assign(Error('provider returned 429'), { status: 429 }); return structuralReview(input); };
  const ok = await core.prepareNode(retried.io);
  assert.equal(ok.ok, true);
  assert.deepEqual([calls, ok.stages.filter(s => s.stage === 'review-transport').length], [4, 2]);
  assert.equal(core.loadNodeState(retried.io, 'G1').evaluatorMetrics.transportRetries, 2);
  for (const [label, setup, code] of [
    ['incompatible request', f => { f.io.review = async () => { throw Object.assign(Error('400 incompatible request'), { status: 400 }); }; }, 'REVIEW_INCOMPATIBLE'],
    ['provider authority', f => { f.io.review = async () => { throw Object.assign(Error('401 invalid credentials'), { status: 401 }); }; }, 'REVIEW_CONFIGURATION'],
    ['malformed review', f => { f.io.review = async () => ({criteria:[]}); }, 'REVIEW_RESPONSE_INVALID'],
    ['length exhausted', f => { f.io.review = async () => { throw Object.assign(Error('review exceeds bounded response'), {code:'REVIEW_TOO_LARGE'}); }; }, 'REVIEW_TOO_LARGE'],
    ['runner', f => { f.io.exec = async (command, options) => command === 'observe:feature' && read(options.cwd, 'feature') === 'pending'
      ? run(null, { error: 'temporary runner failure', errorCode: 'RUNNER_ERROR' }) : f.exec(command, options); }, 'RUNNER_ERROR'],
    ['runtime IO', f => { fs.writeFileSync(path.join(f.cwd, 'node_modules'), 'not a directory'); core.releaseBaseline(f.cwd); }, 'ENOTDIR'],
    ['late supervisor IO', f => { f.io.review=async input=>{
      if(input.phase==='assess')fs.writeFileSync(path.join(core.storePaths(f.cwd).baselineDir,'manifest.json'),'{');
      return structuralReview(input);
    }; }, 'IO_ERROR'],
    ['missing specification', f => { assert.equal(core.draftNode(f.io, { ...f.args, revise: 'G1', specificationPaths: ['.agents/artifacts/missing.md'] }).ok, true); }, 'SPECIFICATION_UNAVAILABLE'],
  ]) {
    const f = project(t, { commands: true });
    setup(f);
    const failed = await core.prepareNode(f.io);
    assert.equal(failed.ok,false,label);
    assert.equal(core.loadRoot(f.io,'G1').status, 'ACTIVE', label);
    assert.ok(failed.diagnostics.some(d=>d.code===code),`${label}: ${JSON.stringify(failed.diagnostics)}`);
    const node = core.loadNodeState(f.io, 'G1');
    assert.deepEqual([node.status,node.phase],['DRAFT','EVALUATOR_PREPARATION'],label);
    assert.equal(node.evaluatorMetrics.e0Attempts, 0, label);
    assert.equal(node.preparing, undefined, label);
    assert.equal(fs.existsSync(core.storePaths(f.cwd).operation), false, label);
    assert.equal(core.approveRoot(f.io).ok, false, label);
  }
});

test('recovery: legacy unsealed pauses unlock every editing boundary without resetting budgets or evidence', async t => {
  for(const boundary of ['revise','request','approve','complete','prepare','budget','external','no-progress'])await t.test(boundary,async t=>{
    const f=project(t,{policy:{evaluatorAttempts:1}});
    assert.equal((await core.prepareNode(f.io)).ok,true);
    const diagnostics=[{code:'REVIEW_TOO_LARGE',stage:'quality',evidence:'length',repairability:'supervisor'}];
    if(['approve','complete'].includes(boundary))assert.equal(core.requestTestStaging(f.io,'G1',{reason:'Write focused tests',paths:['proof.test.mjs']}).ok,true);
    if(boundary==='complete') {
      assert.equal(core.approveTestStaging(f.io,'G1',{userApproval:'Yes, write the tests'}).ok,true);
      fs.writeFileSync(path.join(f.cwd,'proof.test.mjs'),"export const acceptance=true;");
    }
    const node=core.loadNodeState(f.io,'G1');
    node.phase='EVALUATOR_PREPARATION';node.diagnostics=diagnostics;
    node.preparing=true;node.preparationReservation={at:100,attempt:1,operationToken:'interrupted-operation'};
    delete node.prepared;delete node.preparedDigest;
    core.saveNodeState(f.io,node);
    const root=core.loadRoot(f.io,'G1');
    root.status='PAUSED';root.pause={code:boundary==='budget'?'EVALUATOR_UNBUILDABLE':boundary==='external'?'REVIEW_CONFIGURATION':'REVIEW_RESPONSE_INVALID',reason:'legacy preparation failure',nodeId:'G1',operation:'prepare',phase:'EVALUATOR_PREPARATION',at:101};
    if(boundary==='no-progress')Object.assign(root.pause,{code:'NO_PROGRESS',operation:'evaluate',recovery:'repair'});
    root.pauseHistory=[structuredClone(root.pause)];
    root.executionGrants=[{approvedBy:'user',evaluatorAttempts:1,at:99}];
    core.saveRoot(f.io,root);
    let result;
    if(['revise','external','no-progress'].includes(boundary))result=core.draftNode(f.io,{...f.args,revise:'G1'});
    if(['request','budget'].includes(boundary))result=core.requestTestStaging(f.io,'G1',{reason:'Write focused tests',paths:['proof.test.mjs']});
    if(boundary==='approve')result=core.approveTestStaging(f.io,'G1',{userApproval:'Yes, write the tests'});
    if(boundary==='complete')result=core.completeTestStaging(f.io,'G1');
    if(boundary==='prepare') {
      // A recorded explicit grant is retained; the saved leaf limit is authoritative.
      const granted=core.loadNodeState(f.io,'G1');granted.evaluatorAttemptLimit=2;core.saveNodeState(f.io,granted);
      result=await core.prepareNode(f.io);
    }
    assert.equal(result.ok,true,JSON.stringify(result));
    const recovered=core.loadRoot(f.io,'G1'),state=core.loadNodeState(f.io,'G1');
    assert.equal(recovered.status,'ACTIVE');assert.equal(recovered.pause,undefined);
    assert.equal(state.preparing,undefined,'recovery clears only the interrupted in-progress flag');
    if(boundary!=='prepare')assert.deepEqual(state.preparationReservation,node.preparationReservation,'the interrupted reservation is not refunded');
    for(const key of ['policy','consumedAttempts','deadlineAt','executionGrants','pauseHistory','stack'])assert.deepEqual(recovered[key],root[key],key);
    assert.equal(state.evaluatorMetrics.e0Attempts,boundary==='prepare'?2:1);
    if(['revise','request','approve','external','budget','no-progress'].includes(boundary))assert.deepEqual(state.diagnostics,diagnostics,'recovery retains diagnostics');
    assert.equal(recovered.approval,undefined,'recovery grants no approval');
    if(boundary!=='prepare')assert.equal(core.approveRoot(f.io).ok,false,'unprepared recovery cannot be approved');
    if(boundary==='prepare')assert.equal(state.phase,'READY_FOR_APPROVAL');
    if(boundary==='complete')assert.deepEqual(state.testStagingHistory[0].files,['proof.test.mjs']);
    if(boundary==='budget') {
      assert.equal(core.approveTestStaging(f.io,'G1').ok,true);
      assert.equal(core.completeTestStaging(f.io,'G1').ok,true);
      const exhausted=await core.prepareNode(f.io);
      assert.equal(exhausted.pause.code,'EVALUATOR_UNBUILDABLE','unlocking staging never adds evaluator attempts');
      assert.equal(core.resumeRoot(f.io).ok,false,'grant still required');
      const resumed=core.resumeRoot(f.io,{evaluatorAttempts:1});
      assert.deepEqual([resumed.ok,resumed.retry,resumed.operation],[true,false,'continue']);
      assert.equal(core.loadNodeState(f.io,'G1').evaluatorAttemptLimit,2);
    }
  });
  // Sealed execution cannot use draft repair or staging to clear its pause.
  const sealed=project(t);await seal(sealed);
  core.pauseNode(sealed.io,{code:'RUNNER_ERROR',reason:'runner unavailable'});
  const before=core.loadRoot(sealed.io,'G1');
  assert.equal(core.draftNode(sealed.io,{...sealed.args,revise:'G1'}).ok,false);
  assert.equal(core.requestTestStaging(sealed.io,'G1',{reason:'Change proof'}).ok,false);
  assert.equal((await core.prepareNode(sealed.io)).ok,false);
  assert.deepEqual(core.loadRoot(sealed.io,'G1'),before);
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
  f.args.criteria[0].check.recipe.command = command;
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
    const check = core.runCheck({ id: 'C1', check: custom('printf ready > started-check; (sleep 0.3; printf late > late) & sleep 10') },
      sandboxCommand, f.cwd, 5000, options ?? { signal: abort.signal });
    if (!options) { await waitFor(() => read(f.cwd, 'started-check') === 'ready'); abort.abort(); }
    const result = await check;
    assert.equal(result.errorCode, code, label);
    await sleep(400);
    assert.equal(read(f.cwd, 'late'), null, label);
  }
  const recipe = await core.runCheck({ id: 'C1', check: custom('sleep 10') }, sandboxCommand, f.cwd, 5000, { deadlineAt: Date.now() + 80 });
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
  node.attempts = 0; delete node.reservedCandidateDigest;
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

test('recovery: other store generations are archived untouched, and forged bundles fail closed', async t => {
  // A store from another generation is never interpreted: it is archived whole and a fresh root starts.
  const old = project(t, { commands: true });
  await seal(old);
  done(old);
  const candidate = core.digestTree(old.cwd);
  const store = core.storePaths(old.cwd), index = core.loadIndex(old.cwd);
  delete index.formatVersion; index.version = 1;
  core.saveIndex(old.cwd, index);
  const sealedBytes = fs.readFileSync(core.sealedFile(old.cwd, 'G1'), 'utf8');
  assert.deepEqual(core.statusSnapshot(old.io), { active: false, roots: [] });
  const [archive] = fs.readdirSync(store.archiveDir);
  assert.equal(fs.readFileSync(path.join(store.archiveDir, archive, 'contracts/G1.sealed.json'), 'utf8'), sealedBytes);
  assert.equal(core.digestTree(old.cwd), candidate, 'the candidate is untouched');
  assert.equal(core.resumeRoot(old.io, { rootId: 'G1' }).ok, false);
  assert.equal(core.draftNode(old.io, old.args).id, 'G1');
  assert.equal(core.loadIndex(old.cwd).formatVersion, core.STORE_FORMAT_VERSION);
  assert.deepEqual(fs.readdirSync(store.archiveDir), [archive]);
  // A rehashed bundle cannot replace its supervisor identity.
  const forged = project(t);
  await seal(forged);
  const bundle = core.loadBundle(forged.io, 'G1');
  bundle.contract.criteria[0].check.recipe.value = 'pending';
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
