/** Evaluator quality, isolation, and frozen-evidence invariants. See INVARIANTS.md. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, baseline, variants, fullSuite } from './test/suite.mjs';
import * as core from './exitcode-core.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { REVIEW_MAX_TOKENS, callReview, parseReviewText, reviewPrompt, validateCritic, criticInput } from './exitcode-quality.mjs';
import { applyMutations, captureEvaluatorAssets, compileRecipe, lintEvaluators, restoreEvaluatorAssets, runRecipe, sandboxCommand, evaluatorCommand, scanCapabilities, verifyEvaluatorAssets } from './exitcode-evaluator.mjs';
import { structuralReview } from './test/structural-review.mjs';

const read = (cwd, file) => fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), 'utf8') : null;
function workspace(t, files = { feature: 'pending' }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-evaluator-'));
  const cwd = path.join(parent, 'project');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  }
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => { releasePreparation(cwd); fs.rmSync(parent, { recursive: true, force: true }); });
  return cwd;
}
const custom = command => ({ recipe: { kind: 'custom_command', command } });
const OUTCOMES = [{ id: 'O1', requirement: 'The feature is done' }];
const literal = (extra = {}) => [{ id: 'C1', outcome: 'O1', check: { recipe: { kind: 'file_contains', path: 'feature', value: 'done' } }, ...extra },
  { id: 'C2', requirement: 'Artifact persists', type: 'regression', check: { recipe: { kind: 'file_exists', path: 'feature' } } }];
async function prepare(cwd, criteria, overrides = {}, args = {}) {
  const io = core.makeIo(cwd, { review: structuralReview, ...overrides });
  const drafted = core.draftNode(io, { goal: 'Complete feature', outcomes: OUTCOMES, criteria, ...args });
  assert.equal(drafted.ok, true, JSON.stringify(drafted.errors));
  return { io, result: await core.prepareNode(io) };
}
const codes = result => result.diagnostics.map(d => d.code);

// ---------------------------------------------------------------------------
// Explicit intent contract with a best-effort semantic critic
// ---------------------------------------------------------------------------

const good = "const p={};export function save(v){if(v==='invalid')throw Error('invalid');p.zone=v;}export function get(){return p.zone;}";
const noop = "export function save(v){if(v==='invalid')throw Error('invalid');}export function get(){return undefined;}";
const observe = "import assert from 'node:assert/strict';import {save,get} from './store.mjs';assert.equal(get(),undefined);save('Europe/London');assert.equal(get(),'Europe/London');assert.throws(()=>save('invalid'));save('America/New_York');assert.equal(get(),'America/New_York');";

function scenario(t, mode = 'strong') {
  const cwd = workspace(t, { 'store.mjs': good, 'profile.txt': 'existing',
    'profile.test.mjs': "import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';test('profile artifact remains',()=>assert.equal(readFileSync('profile.txt','utf8'),'existing'));" });
  const outcomes = [{ id: 'O1', requirement: 'Saving a timezone persists the selected value and rejects invalid input' }];
  const criteria = [{ id: 'C1', outcome: 'O1',
    check: { recipe: { kind: 'command_exit', command: 'node', args: ['--input-type=module', '-e', observe] } },
    controls: { accept: { mutations: [{ kind: 'write_file', path: 'store.mjs', content: good }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'store.mjs', content: noop }] }] } },
  { id: 'C2', requirement: 'Existing profile artifact remains', type: 'regression', check: { recipe: { kind: 'existing_test', path: 'profile.test.mjs', selector: 'profile artifact remains' } } }];
  const structural = mode === 'structural';
  if (structural) {
    fs.writeFileSync(path.join(cwd, 'LICENSE'), 'MIT');
    outcomes[0] = { id: 'O1', requirement: 'Package includes LICENSE' };
    Object.assign(criteria[0], {  check: { recipe: { kind: 'file_exists', path: 'LICENSE' } } });
    delete criteria[0].controls;
  }
  if (mode === 'thin' || mode === 'thin-new-feature') delete criteria[0].controls;
  if (mode === 'new-feature' || mode === 'thin-new-feature') fs.unlinkSync(path.join(cwd, 'store.mjs'));
  if (mode === 'missing-outcome') delete criteria[0].outcome;
  if (mode === 'unknown-outcome') criteria[0].outcome = 'O9';
  if (mode === 'uncovered-outcome') outcomes.push({ id: 'O2', requirement: 'Uncovered second outcome' });
  if (mode === 'setup-error') criteria[0].controls.reject[0].mutations = [{ kind: 'replace_text', path: 'store.mjs', from: 'missing substring', to: 'bad' }];
  if (mode === 'witness-regression') criteria[0].controls.accept.mutations.push({ kind: 'write_file', path: 'profile.txt', content: 'broken' });
  const calls = [];
  const review = async (input, { signal }) => {
    assert.ok(signal instanceof AbortSignal); calls.push(input);
    if (mode === 'review-error') throw Error('provider failure');
    if (mode === 'review-timeout') return new Promise(() => {});
    assert.equal(input.phase, 'critic');
    assert.deepEqual(input.outcomes, outcomes);
    assert.ok(!JSON.stringify(input).includes('command_exit') && !JSON.stringify(input).includes('store.mjs'), 'critic sees outcomes only');
    if (mode === 'critic-concern') return { concerns: [{ code: 'MISSING_OUTCOME', evidence: 'The request explicitly requires cancellation but no outcome covers it' }] };
    if (mode === 'critic-bundled') return { concerns: [{ code: 'BUNDLED_OUTCOME', evidence: 'Persistence and rejection can independently pass or fail' }] };
    if (mode === 'malformed') return { concerns: [{ code: 'BOGUS', evidence: '' }] };
    return { concerns: [] };
  };
  const io = core.makeIo(cwd, { ...(mode === 'missing-review' ? {} : { review }), reviewTimeoutMs: mode === 'review-timeout' ? 10 : 30000,
    ...(mode === 'runner-error' ? { exec: async (cmd, o) => { const r = await sandboxCommand(cmd, o); return r.exit === 1 ? { ...r, error: 'runner error' } : r; } } : {}) });
  assert.equal(core.draftNode(io, { goal: 'Timezone behavior', outcomes, criteria,
    originalRequest: structural ? 'Include LICENSE' : 'Save timezone, reject invalid input and preserve profile updates' }).ok, true);
  return { cwd, io, calls };
}

baseline('semantic: adequate behavioral, structural, and new-feature evaluators reach approval with the candidate unchanged', async t => {
  for (const mode of variants(['strong', 'structural', 'new-feature', 'thin-new-feature'], ['strong', 'thin-new-feature'])) await t.test(mode, async t => {
    const { cwd, io, calls } = scenario(t, mode), before = core.digestTree(cwd), r = await core.prepareNode(io);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(core.digestTree(cwd), before);
    assert.equal(calls.length, 1, 'one best-effort critic call after deterministic evidence');
    assert.equal(core.statusSnapshot(io).awaitingApproval, true);
    assert.ok(r.stages.find(s => s.stage === 'regression-witness'), 'behavior witnesses must not break regressions');
    if (mode === 'structural') assert.ok(r.stages.find(s => s.stage === 'adversarial').probes.length > 0, 'built-ins get supervisor negatives');
    assert.match(r.review, /Mechanical evaluator validation: PASS/);
    assert.match(r.review, /Semantic critic: pass/);
    assert.equal(core.loadRoot(io, 'G1').approval, undefined);
  });
});

test('semantic: critic transport failures never block deterministic evidence', async t => {
  for (const mode of ['missing-review', 'review-error', 'review-timeout', 'malformed']) await t.test(mode, async t => {
    const { cwd, io } = scenario(t, mode), before = core.digestTree(cwd), r = await core.prepareNode(io);
    assert.equal(r.ok, true, `${mode}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(core.digestTree(cwd), before);
    assert.match(r.review, /Semantic critic: unavailable/);
    assert.match(r.review, /Mechanical evaluator validation: PASS/);
    assert.equal(core.statusSnapshot(io).awaitingApproval, true);
  });
});

test('semantic: critic concerns are visible warnings and never veto mechanical evidence', async t => {
  for(const [mode,code] of [['critic-concern','MISSING_OUTCOME'],['critic-bundled','BUNDLED_OUTCOME']]) await t.test(mode,async t=>{
    const {io}=scenario(t,mode),r=await core.prepareNode(io);
    assert.equal(r.ok,true,JSON.stringify(r));
    assert.deepEqual(r.diagnostics,[]);
    assert.ok(r.warnings.some(w=>w.includes(code)));
    assert.match(r.review,new RegExp(`Warnings[\\s\\S]*${code}`));
    assert.match(core.statusText(io),new RegExp(code));
    assert.equal(core.approveRoot(io).ok,true);
    assert.equal((await core.sealNode(io,'G1')).ok,true);
  });
});

baseline('semantic: uncovered, unchallenged, or contradictory evaluators never reach approval', async t => {
  const expected = { 'missing-outcome': 'OUTCOME_MISSING', 'unknown-outcome': 'OUTCOME_UNKNOWN', 'uncovered-outcome': 'OUTCOME_UNCOVERED',
    thin: 'NEGATIVE_EVIDENCE_MISSING', 'setup-error': 'CONTROL_SETUP_FAILED',
    'witness-regression': 'REGRESSION_ON_WITNESS', 'runner-error': 'RUNNER_ERROR' };
  for (const mode of variants(Object.keys(expected), ['uncovered-outcome', 'thin'])) await t.test(mode, async t => {
    const { cwd, io } = scenario(t, mode), before = core.digestTree(cwd), r = await core.prepareNode(io);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.diagnostics.length);
    if (expected[mode]) assert.ok(codes(r).includes(expected[mode]), `${mode}: ${codes(r)}`);
    assert.equal(core.digestTree(cwd), before);
    assert.equal(r.review, undefined);
    assert.equal(core.statusSnapshot(io).awaitingApproval, false);
    assert.equal(core.approveRoot(io).ok, false);
  });
  {
    const cwd = workspace(t, { 'store.mjs': good, 'profile.txt': 'existing',
      'profile.test.mjs': "import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';test('profile artifact remains',()=>assert.equal(readFileSync('profile.txt','utf8'),'existing'));" });
    const io = core.makeIo(cwd, { review: structuralReview });
    const bad = core.draftNode(io, { goal: 'g', outcomes: [{ id: 'O1', requirement: 'o' }],
      criteria: [{ id: 'C1', outcome: 'O1', check: { recipe: { kind: 'file_exists', path: 'store.mjs' } } },
        { id: 'C2', requirement: 'r', type: 'regression', outcome: 'O1', check: { recipe: { kind: 'file_exists', path: 'profile.txt' } } }] });
    assert.equal(bad.ok, false, 'regression criteria must not claim requested outcomes');
  }
});

// ---------------------------------------------------------------------------
// Thin evaluator drafts
// ---------------------------------------------------------------------------

baseline('witnesses: built-in recipes need no controls; baseline-failing checks need no positive witness', async t => {
  const thin = workspace(t);
  const { result } = await prepare(thin, literal());
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const accept = result.stages.find(s => s.stage === 'discrimination').probes.find(p => p.label === 'accept');
  assert.equal(accept.outcome.status, 'PASS', 'supervisor-generated positive witness');
  assert.ok(result.stages.find(s => s.stage === 'adversarial').probes.length >= 2, 'supervisor-generated negatives');
  for (const [label, value] of [['json', { kind: 'json_value', path: 'config.json', pointer: '/feature/enabled', value: true }],
    ['absence', { kind: 'file_not_contains', path: 'feature', value: 'pending' }]]) {
    const { result } = await prepare(workspace(t), [{ id: 'C1', outcome: 'O1', check: { recipe: value } }, literal()[1]]);
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.diagnostics)}`);
  }
  // Passing baselines supply positive evidence; failing baselines need no authored witness.
  const command = (cmd, extra = {}) => [{ id: 'C1', outcome: 'O1', check: custom(cmd), controls: { reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] }, ...extra }, literal()[1]];
  const exec = async (cmd, { cwd }) => ({ exit: read(cwd, 'feature') === (cmd === 'observe-done' ? 'done' : 'pending') ? 0 : 1, stdout: '', stderr: '', timedOut: false });
  const existing = (await prepare(workspace(t), command('observe-pending'), { exec })).result;
  assert.equal(existing.ok, true, JSON.stringify(existing.diagnostics));
  assert.match(existing.review, /baseline PASS, rejected 1 negative/);
  assert.equal(existing.stages.find(s => s.stage === 'discrimination').probes.filter(p => p.label === 'accept').length, 0);
  assert.equal(existing.stages.find(s => s.stage === 'determinism').probes.length, 1);
  const missing = (await prepare(workspace(t), command('observe-done'), { exec })).result;
  assert.equal(missing.ok, true, JSON.stringify(missing.diagnostics));
  assert.equal(missing.stages.find(s => s.stage === 'determinism').probes.length, 0);
  assert.equal(missing.stages.find(s => s.stage === 'discrimination').probes.some(p => p.label === 'accept'), false);
  const authored = command('observe-done', { controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] } });
  assert.equal((await prepare(workspace(t), authored, { exec })).result.ok, true);
  // A new behavior whose baseline already fails needs no explicit reject; one the baseline satisfies does.
  const witnessOnly = [{ id: 'C1', outcome: 'O1', check: custom('observe-done'),
    controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] } } }, literal()[1]];
  assert.equal((await prepare(workspace(t), witnessOnly, { exec })).result.ok, true, 'baseline FAIL plus witness PASS proves discrimination');
  const baselineFail = [{ id: 'C1', outcome: 'O1', check: custom('observe-done') }, literal()[1]];
  const prospective = await prepare(workspace(t), baselineFail, { exec });
  assert.equal(prospective.result.ok, true, JSON.stringify(prospective.result.diagnostics));
  assert.equal(prospective.result.metrics.probeExecutions, 4, 'only baseline and wiring for behavior and regression');
  assert.equal(prospective.result.stages.find(s => s.stage === 'regression-witness').probes.length, 0);
  assert.match(prospective.result.review, /baseline FAIL, implementation will establish success post-seal/);
  assert.ok(!prospective.result.warnings.some(w => /SATISFIABILITY|positive witness/i.test(w)));
  assert.equal(core.statusSnapshot(prospective.io).awaitingApproval, true);
  assert.equal((await core.sealNode(prospective.io, 'G1', { userApproval: 'Approve' })).ok, true);
  assert.equal((await core.evaluateNode(prospective.io, 'G1')).status, 'ACTIVE', 'approval does not establish implementation success');
  const unchallenged = (await prepare(workspace(t), [{ id: 'C1', outcome: 'O1', check: custom('observe-pending') }, literal()[1]], { exec })).result;
  assert.ok(codes(unchallenged).includes('NEGATIVE_EVIDENCE_MISSING'));
});

baseline('witnesses: prospective test assets reach approval and require fresh implementation success after sealing', async t => {
  const cwd = workspace(t, { 'src/value.mjs': "export const value = 'pending';" });
  const before = core.digestTree(cwd);
  const { io, result } = await prepare(cwd, [{ id: 'C1', outcome: 'O1',
    check: { recipe: { kind: 'test_asset', asset: 'value.test.mjs', command: 'node', args: ['--test'] } } }], {}, {
    assets: { 'value.test.mjs': "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.mjs';test('reports done',()=>assert.equal(value,'done'));" }
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.metrics.probeExecutions, 2, 'only baseline and empty-target probes');
  assert.equal(core.digestTree(cwd), before, 'preparation leaves product source unchanged');
  assert.match(result.review, /baseline FAIL, implementation will establish success post-seal/);
  assert.equal((await core.sealNode(io, 'G1', { userApproval: 'Approve' })).ok, true);
  assert.equal((await core.evaluateNode(io)).status, 'ACTIVE');
  fs.writeFileSync(path.join(cwd, 'src/value.mjs'), "export const value = 'done';");
  assert.equal((await core.evaluateNode(io)).status, 'PASS');
});

baseline('witnesses: controls that resemble a reference implementation are rejected before review', async t => {
  const big = 'x'.repeat(70 * 1024), shared = 'y'.repeat(10 * 1024);
  const control = content => ({ accept: { mutations: [{ kind: 'write_file', path: 'feature', content }] } });
  for (const [label, criteria, outcomes] of [
    ['bytes', literal({ controls: control(big) }), OUTCOMES],
    ['files', literal({ controls: { accept: { mutations: Array.from({ length: 17 }, (_, i) => ({ kind: 'write_file', path: `src/f${i}.mjs`, content: 'done' })) } } }), OUTCOMES],
    ['repeated', [...literal({ controls: control(shared) }), { id: 'C3', outcome: 'O2', check: { recipe: { kind: 'file_contains', path: 'feature', value: 'y' } }, controls: control(shared) }], [...OUTCOMES, { id: 'O2', requirement: 'Another outcome' }]],
  ]) {
    let reviews = 0;
    const { result } = await prepare(workspace(t), criteria, { review: async input => { reviews++; return structuralReview(input); } }, { outcomes });
    const overbuilt = result.diagnostics.find(d => d.code === 'EVALUATOR_OVERBUILT');
    assert.ok(overbuilt, `${label}: ${codes(result)}`);
    assert.match(overbuilt.recommendedRepair, /minimal witness/);
    assert.equal(reviews, 0, `${label} never reaches semantic review`);
  }
});

// ---------------------------------------------------------------------------
// Review boundary: compact schemas, bounded context, cancellation
// ---------------------------------------------------------------------------

test('review: critic concerns are compact and clipped; responses and prompts are bounded', async () => {
  const diagnostics = validateCritic({ concerns: [{ code: 'MISSING_OUTCOME', evidence: 'o'.repeat(5000) }] });
  assert.deepEqual(diagnostics.map(d => d.code), ['MISSING_OUTCOME']);
  assert.ok(diagnostics[0].evidence.length <= 300);
  assert.deepEqual(validateCritic({ concerns: [] }), []);
  for (const bad of [{}, { concerns: 'x' }, { concerns: [{ code: 'BOGUS', evidence: 'x' }] },
    { concerns: [{ code: 'MISSING_OUTCOME', evidence: '' }] },
    { concerns: Array.from({ length: 4 }, () => ({ code: 'MISSING_OUTCOME', evidence: 'x' })) }])
    assert.throws(() => validateCritic(bad), e => e.code === 'REVIEW_RESPONSE_INVALID');
  assert.ok(REVIEW_MAX_TOKENS <= 1024);
  assert.doesNotMatch(reviewPrompt('critic'), /SEQUENCE_INVALID/);
  assert.doesNotMatch(reviewPrompt('critic'), /nearMiss|sham/i);
  assert.match(reviewPrompt('critic'), /MISSING_OUTCOME.*OVERREACH.*CONTRADICTION.*BUNDLED_OUTCOME/);
  assert.ok(reviewPrompt('critic').length < 2600, 'critic prompt is compact');
  assert.match(reviewPrompt('critic'), /submit_review/);
  assert.throws(() => reviewPrompt('derive'), /unknown review phase/);
  await assert.rejects(callReview(() => ({ large: 'x'.repeat(70 * 1024) }), {}), /too large/);
  for (const text of ['{"a":1}', 'Here is the requested review:\n\n```json\n{"a":1}\n```', '{"a":1}\n\nHope this helps.', '```\n{"a":1}\n```'])
    assert.deepEqual(parseReviewText(text), { a: 1 });
  for (const text of ['', 'not JSON', '```json\n{broken\n```', 'no object here'])
    assert.throws(() => parseReviewText(text), e => e.code === 'REVIEW_RESPONSE_INVALID');
});

test('review: critic input carries outcomes only, with small explicit specification text', t => {
  const cwd = workspace(t, { 'store.mjs': good, 'plan.md': 'Required outcome: the store persists.', 'huge.md': 'x'.repeat(20000) });
  const draft = { originalRequest: 'Persist the store', goal: 'Persist', outcomes: [{ id: 'O1', requirement: 'Store persists' }],
    criteria: [{ id: 'C1', outcome: 'O1', check: { recipe: { kind: 'file_exists', path: 'store.mjs' } } }],
    specificationPaths: ['plan.md', 'missing.md'] };
  const input = criticInput(draft, cwd);
  assert.equal(input.phase, 'critic');
  assert.deepEqual(input.outcomes, draft.outcomes);
  assert.ok(!JSON.stringify(input).includes('file_exists'), 'no checks in critic input');
  assert.ok(input.specificationText.includes('Required outcome'));
  assert.ok(!input.specificationText.includes('missing.md'));
  const big = criticInput({ ...draft, specificationPaths: ['huge.md'] }, cwd);
  assert.ok(Buffer.byteLength(big.specificationText) <= 8192);
});

test('review: cancellation aborts reviewers, default watchdog bounds slow critics', async t => {
  const parent = new AbortController(); let nested;
  await assert.rejects(callReview(async (_input, { signal }) => { nested = signal; parent.abort(); return new Promise(() => {}); }, {}, { signal: parent.signal }), /cancelled/);
  assert.equal(nested.aborted, true);
  const already = new AbortController(); already.abort(); let calls = 0;
  await assert.rejects(callReview(() => { calls++; }, {}, { signal: already.signal }), e => e.code === 'CANCELLED');
  assert.equal(calls, 0);
  for (const timeoutMs of [0, -1, Infinity, NaN]) await assert.rejects(callReview(() => ({}), {}, { timeoutMs }), /finite and positive/);
  await assert.rejects(callReview(() => new Promise(() => {}), {}, { timeoutMs: 5 }), e => e.code === 'REVIEW_TIMEOUT');
  assert.ok(core.REVIEW_TIMEOUT_MS >= 10_000 && core.REVIEW_TIMEOUT_MS <= 15_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed=0;
  t.mock.method(performance,'now',()=>elapsed);
  let slowSignal;
  const slow = callReview((_input, { signal }) => { slowSignal = signal; return new Promise(resolve => setTimeout(() => resolve({ reviewed: true }), 45000)); }, {});
  const rejected = assert.rejects(slow,e=>e.code==='REVIEW_TIMEOUT');
  await Promise.resolve();
  elapsed=core.REVIEW_TIMEOUT_MS;
  t.mock.timers.tick(core.REVIEW_TIMEOUT_MS);
  await rejected;
  assert.equal(slowSignal.aborted, true);

});

// ---------------------------------------------------------------------------
// Mechanical discrimination
// ---------------------------------------------------------------------------

baseline('discrimination: overfitted rejects, duplicates, false positives, and inconclusive probes never reach review', async t => {
  const overfitted = literal({ controls: { reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }] } });
  const cwd = workspace(t);
  const { io, result } = await prepare(cwd, overfitted);
  assert.ok(codes(result).includes('REJECT_NOT_DISCRIMINATED'));
  assert.equal(core.approveRoot(io).ok, false);
  assert.equal(core.draftNode(io, { goal: 'Complete feature', criteria: literal(), revise: 'G1' }).ok, true);
  assert.equal((await core.prepareNode(io)).ok, true, 'repair precedes review without spending execution');
  assert.equal(core.statusSnapshot(io).consumedAttempts, 0);
  if (fullSuite) {
    const duplicate = literal(); duplicate[1].requirement = OUTCOMES[0].requirement;
    assert.ok(codes((await prepare(workspace(t), duplicate)).result).includes('DUPLICATE_CRITERION'));
  }
  // Empty-target wiring: a check that passes against nothing proves nothing.
  const always = async () => ({ exit: 0, stdout: '', stderr: '', timedOut: false });
  assert.ok(codes((await prepare(workspace(t), [literal()[0], { ...literal()[1], check: custom('always') }], { exec: always })).result).includes('EMPTY_TARGET_PASS'));
  // Inconclusive reject probes and unappliable witnesses are never rejection evidence.
  const observed = async (_cmd, { cwd }) => ({ exit: read(cwd, 'feature') === 'done' ? 0 : 1, stdout: '', stderr: '', timedOut: false });
  const broken = { mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] };
  for (const [label, reject, failure, code] of variants([['timeout', broken, { timedOut: true }, 'RUNNER_ERROR'], ['error', broken, { error: 'unavailable' }, 'RUNNER_ERROR'],
    ['unappliable', { mutations: [{ kind: 'replace_text', path: 'feature', from: 'absent', to: 'x' }] }, null, 'CONTROL_SETUP_FAILED']], [])) {
    const exec = async (cmd, options) => failure && read(options.cwd, 'feature') === 'broken' ? { exit: null, stdout: '', stderr: '', timedOut: false, ...failure } : observed(cmd, options);
    const criteria = [{ id: 'C1', outcome: 'O1', check: custom('observe'), controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [reject] } }, literal()[1]];
    const r = (await prepare(workspace(t), criteria, { exec })).result;
    assert.equal(r.ok, false, label);
    assert.ok(!codes(r).includes('REJECT_NOT_DISCRIMINATED'), `${label}: ${codes(r)}`);
    if (code === 'CONTROL_SETUP_FAILED') assert.ok(codes(r).includes(code), `${label}: ${codes(r)}`);
  }
  if (fullSuite) {
    const external = (await prepare(workspace(t), [{ ...literal()[0], check: custom('curl https://example.com') }, literal()[1]])).result;
    assert.ok(codes(external).includes('EXTERNAL_DEPENDENCY'));
  }
});

baseline('discrimination: inconsistent outcomes fail determinism, but harmless stdout variation does not', async t => {
  let n = 0;
  const flaky = async (_cmd, { cwd }) => ({ exit: read(cwd, 'feature') === 'done' && ++n % 2 === 1 ? 0 : 1, stdout: '', stderr: '', timedOut: false });
  const criteria = [{ id: 'C1', outcome: 'O1', check: custom('observe'), controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'pending' }] }] } }, literal()[1]];
  assert.ok(codes((await prepare(workspace(t), criteria, { exec: flaky })).result).includes('NONDETERMINISTIC'));
  let count = 0;
  const timing = async (_cmd, { cwd }) => ({ exit: read(cwd, 'feature') === 'done' ? 0 : 1, stdout: `elapsed ${++count}ms`, stderr: '', timedOut: false });
  assert.equal((await prepare(workspace(t), criteria, { exec: timing })).result.ok, true);
});

baseline('recipes: selectors must be literal and discovered, discovery never executes code, and paths stay confined', async t => {
  const cwd = workspace(t, { 'test/a.test.mjs': "import {test} from 'node:test';test('works',()=>{});",
    'package.json': JSON.stringify({ scripts: { test: 'touch leaked' } }), 'value.json': '{}' });
  const cap = scanCapabilities(cwd);
  assert.equal(cap.availableScripts.test, 'touch leaked');
  assert.equal(fs.existsSync(path.join(cwd, 'leaked')), false);
  assert.throws(() => compileRecipe({ kind: 'existing_test', path: 'test/a.test.mjs', selector: 'absent' }, cap), /TEST_SELECTOR_NOT_FOUND/);
  for (const [recipe, code, hints] of [
    [{ kind: 'existing_test', path: 'test/a.test.mjs', selector: 'future behavior' }, 'TEST_SELECTOR_NOT_FOUND', [/never invent/, /test_asset/, /test_suite/]],
    [{ kind: 'existing_test', path: 'future.test.mjs', selector: 'future behavior' }, 'CHECK_TARGET_MISSING', [/never invent/, /test_asset/]],
    [{ kind: 'command_exit', command: './scripts/verify' }, 'INVALID_SPEC', [/basename plus args/, /"command":"sh"/, /scripts\/verify/, /custom_command/, /test_suite/]],
  ]) {
    const diagnostics = lintEvaluators({ criteria: [{ id: 'C1', check: { recipe } }] }, cwd, cap);
    assert.equal(diagnostics[0].code, code);
    for (const hint of hints) assert.match(diagnostics[0].recommendedRepair, hint);
  }
  assert.deepEqual(compileRecipe({ kind: 'command_exit', command: 'sh', args: ['scripts/verify'] }, cap),
    { operation: 'command', executable: 'sh', args: ['scripts/verify'] });
  assert.deepEqual(compileRecipe({ kind: 'custom_command', command: 'sh scripts/verify' }, cap),
    { operation: 'shell', command: 'sh scripts/verify', custom: true });
  assert.deepEqual(compileRecipe({ kind: 'test_suite' }, cap), { operation: 'command', executable: 'npm', args: ['run', 'test'], script: 'test' });
  assert.equal((await runRecipe({ kind: 'existing_test', path: 'test/a.test.mjs', selector: 'works' }, { cwd })).exit, 0);
  fs.writeFileSync(path.join(cwd, 'test/a.test.mjs'), "import {test} from 'node:test';test('other',()=>{});");
  assert.equal((await runRecipe({ kind: 'existing_test', path: 'test/a.test.mjs', selector: 'works' }, { cwd, capabilities: cap })).exit, 1);
  assert.notEqual(scanCapabilities(cwd).digest, cap.digest);
  const outside = workspace(t);
  fs.symlinkSync(outside, path.join(cwd, 'link'));
  for (const p of ['../escape', '/tmp/escape', '.exitcode/escape', 'link/escape']) await assert.rejects(() => applyMutations(cwd, [{ kind: 'write_file', path: p, content: 'bad' }]));
  await assert.rejects(() => applyMutations(cwd, [{ kind: 'set_json_value', path: 'value.json', pointer: '/__proto__/polluted', value: true }]));
  assert.equal({}.polluted, undefined);
});

// ---------------------------------------------------------------------------
// Isolation and identity
// ---------------------------------------------------------------------------

baseline('isolation: checks cannot see host paths, env, or processes and may write only their own fixture', async t => {
  const cwd = workspace(t);
  process.env.EXITCODE_TEST_SECRET = 'hidden';
  try {
    const js = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(cwd)})||process.env.EXITCODE_TEST_SECRET||fs.existsSync('/proc/${process.pid}/root'))process.exit(9);console.log('isolated');`;
    const result = await sandboxCommand('node -e ' + JSON.stringify(js), { cwd, timeoutMs: 5000 });
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal((await sandboxCommand('echo unsafe', { cwd, timeoutMs: 1000, bwrapPath: '/nonexistent/bwrap' })).exit, null, 'strict isolation fails closed');
    // The default executor degrades to a sanitized disposable host process, with a warning, instead of blocking.
    const reduced = await evaluatorCommand('test -z "$EXITCODE_TEST_SECRET" && test "$HOME" != ' + JSON.stringify(os.homedir()) + ' && echo reduced', { cwd, timeoutMs: 5000, bwrapPath: '/nonexistent/bwrap' });
    assert.deepEqual([reduced.exit, reduced.stdout.trim(), reduced.isolation], [0, 'reduced', 'host'], JSON.stringify(reduced));
    assert.match(reduced.isolationWarning, /reduced isolation: bubblewrap unavailable/);
    assert.notEqual((await sandboxCommand('echo mutation > feature', { cwd, timeoutMs: 1000 })).exit, 0);
    assert.equal(read(cwd, 'feature'), 'pending');
    const huge = await sandboxCommand("node -e \"process.stdout.write('x'.repeat(1000000))\"", { cwd, timeoutMs: 5000 });
    assert.ok(huge.truncated && Buffer.byteLength(huge.stdout) <= 65536);
    assert.equal((await sandboxCommand('sleep 10 & wait', { cwd, timeoutMs: 100 })).timedOut, true);
  } finally { delete process.env.EXITCODE_TEST_SECRET; }
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'built\',\'yes\')"' } }));
  fs.writeFileSync(path.join(cwd, 'writes.test.mjs'), "import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('writes output',()=>writeFileSync('test-output','ok'));");
  assert.equal((await runRecipe({ kind: 'build_succeeds' }, { cwd })).exit, 0);
  assert.equal((await runRecipe({ kind: 'existing_test', path: 'writes.test.mjs', selector: 'writes output' }, { cwd })).exit, 0);
});

baseline('identity: stale candidates, environments, or evidence invalidate approval; fresh evaluation bypasses the cache', async t => {
  const cwd = workspace(t);
  const { io, result } = await prepare(cwd, literal());
  assert.equal(result.ok, true);
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.writeFileSync(path.join(cwd, 'node_modules/dependency'), 'changed');
  const approval = core.approveRoot(io);
  assert.match(approval.warnings[0], /node_modules/);
  assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false);
  const warm = await core.prepareNode(io);
  assert.equal(warm.ok, true);
  assert.ok(warm.metrics.cacheHits > 0);
  assert.equal(warm.metrics.reviewCalls, 1, 'warm preparation still runs the best-effort critic');
  const node = core.loadNodeState(io, 'G1');
  node.prepared.baseline.allPass = true;
  core.saveNodeState(io, node);
  assert.equal(core.approveRoot(io).ok, false);
  assert.equal((await core.prepareNode(io)).ok, true);
  assert.equal(core.approveRoot(io).ok, true);
  assert.equal((await core.sealNode(io, 'G1')).ok, true);
  fs.writeFileSync(path.join(cwd, 'feature'), 'done');
  await core.evaluateNode(io);
  assert.equal(core.loadRoot(io, 'G1').status, 'PASS');
  assert.ok(core.loadNodeState(io, 'G1').lastResult.metrics.probeExecutions > 0, 'fresh evaluation reruns checks');
});

// ---------------------------------------------------------------------------
// Immutable sealed proof
// ---------------------------------------------------------------------------

async function sealed(t, files, criteria, args = {}, exec = sandboxCommand) {
  const cwd = workspace(t, { feature: 'pending', ...files });
  const io = core.makeIo(cwd, { review: structuralReview, exec });
  assert.equal(core.draftNode(io, { goal: 'Complete feature', outcomes: OUTCOMES, criteria, ...args }).ok, true);
  const prepared = await core.prepareNode(io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  assert.equal(core.approveRoot(io).ok, true);
  assert.equal((await core.sealNode(io, 'G1')).ok, true);
  return { cwd, io };
}

test('assets: live repository tests and helpers change while sealed copies remain authoritative', async t => {
  const source = "import{readFileSync}from'node:fs';export const value=()=>readFileSync('feature','utf8');";
  const helper = "import{value}from'../src/product.mjs';process.exit(value()==='done'?0:1);";
  const criteria = [{ id: 'C1', outcome: 'O1', check: { ...custom('node checks/accept.mjs'), assets: ['checks/accept.mjs'] },
    controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] } }, literal()[1]];
  const { cwd, io } = await sealed(t, { 'src/product.mjs': source, 'checks/accept.mjs': helper, 'tests/mandatory.test.mjs': 'export const mandatory=true;' }, criteria);
  const bundle = core.loadBundle(io, 'G1');
  assert.ok(bundle.assets.files.some(f => f.path === 'checks/accept.mjs'));
  assert.ok(!bundle.assets.files.some(f => f.path === 'src/product.mjs' || f.path === 'tests/mandatory.test.mjs'));
  fs.writeFileSync(path.join(cwd, 'src/product.mjs'), source + '\n// Permitted product implementation change.\n');
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), 'process.exit(0);');
  fs.writeFileSync(path.join(cwd, 'tests/new.test.mjs'), 'throw Error("not approved acceptance");');
  fs.rmSync(path.join(cwd, 'tests/mandatory.test.mjs'));
  const failed = await core.evaluateNode(io);
  assert.equal(failed.ok,true); assert.equal(core.loadNodeState(io,'G1').lastResult.allPass,false,'live helper cannot weaken the sealed assertion');
  fs.writeFileSync(path.join(cwd, 'feature'), 'done');
  assert.equal((await core.evaluateNode(io)).status, 'PASS');
  assert.equal(read(cwd,'checks/accept.mjs'),'process.exit(0);','evaluation leaves product tests alone');
});

baseline('assets: the evaluator package closure stays frozen while approved product dependencies change', async t => {
  const { cwd, io } = await sealed(t, {
    'package.json': JSON.stringify({ dependencies: { product: '1' }, devDependencies: { verifier: '1' } }),
    'node_modules/product/package.json': '{"name":"product","version":"1"}', 'node_modules/product/value.mjs': 'export const value=1;',
    'node_modules/verifier/package.json': '{"name":"verifier","version":"1","dependencies":{"shared":"1"},"optionalDependencies":{"optional":"1"}}',
    'node_modules/shared/package.json': '{"name":"shared","version":"1"}', 'node_modules/shared/assert.mjs': 'export const assertion=1;',
  }, literal(), { mutableDependencies: true }, async () => { throw Error('built-in recipes execute nothing'); });
  const bundle = core.loadBundle(io, 'G1');
  assert.ok(bundle.assets.files.some(f => f.path === 'node_modules/shared/assert.mjs'));
  assert.ok(!bundle.assets.files.some(f => f.path === 'node_modules/product/value.mjs'));
  fs.writeFileSync(path.join(cwd, 'node_modules/product/value.mjs'), 'export const value=2;');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { product: '2' }, devDependencies: { verifier: '1' } }));
  verifyEvaluatorAssets(cwd, bundle.assetsDirectory, bundle.assets);
  // Live evaluator drift is re-overlaid from the sealed copy and reproved, never a pause.
  fs.writeFileSync(path.join(cwd, 'node_modules/shared/assert.mjs'), 'export const assertion=0;');
  assert.equal((await core.evaluateNode(io)).status, 'ACTIVE');
  assert.equal(fs.readFileSync(path.join(cwd, 'node_modules/shared/assert.mjs'), 'utf8'), 'export const assertion=1;');
  assert.equal(core.loadRoot(io, 'G1').acceptanceRestorations.length, 1);
  // An optional dependency becoming available changes evaluator resolution; it is removed the same way.
  fs.mkdirSync(path.join(cwd, 'node_modules/optional'));
  fs.writeFileSync(path.join(cwd, 'node_modules/optional/package.json'), '{"name":"optional"}');
  assert.equal((await core.evaluateNode(io)).status, 'ACTIVE');
  assert.equal(fs.existsSync(path.join(cwd, 'node_modules/optional')), false);
  fs.writeFileSync(path.join(cwd, 'feature'), 'done');
  assert.equal((await core.evaluateNode(io)).status, 'PASS');
});

test('assets: capture canonicalizes declared paths, pins runtimes and configuration, and restoration never writes outside', t => {
  const cwd = workspace(t, { feature: 'pending', 'checks/accept.mjs': 'process.exit(1);', 'checks/fixtures/expected.json': '{"valid":true}',
    'package.json': '{"name":"product","dependencies":{"cli":"1"},"devDependencies":{"review":"1"},"scripts":{"test":"node --test"}}',
    'node_modules/cli/package.json': '{"name":"cli","bin":{"cli":"bin.mjs"}}', 'node_modules/cli/bin.mjs': 'process.exit(0);', 'node_modules/review/package.json': '{"name":"review"}' });
  fs.mkdirSync(path.join(cwd, 'node_modules/.bin'));
  fs.symlinkSync('../cli/bin.mjs', path.join(cwd, 'node_modules/.bin/cli'));
  const draft = { criteria: [{ id: 'C1', check: { ...custom('node checks/accept.mjs'), assets: ['./checks//accept.mjs', './checks/fixtures/'] } }], mutableDependencies: true };
  const directory = path.join(cwd, '.exitcode/assets/test');
  const assets = captureEvaluatorAssets(cwd, draft, directory);
  for (const file of ['checks/accept.mjs', 'checks/fixtures/expected.json', 'node_modules/cli/bin.mjs']) assert.ok(assets.files.some(f => f.path === file), file);
  assert.ok(assets.directories.includes('checks/fixtures'));
  verifyEvaluatorAssets(cwd, directory, assets);
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), 'process.exit(0);');
  verifyEvaluatorAssets(cwd, directory, assets); // The repository copy is product content.
  const frozenHelper = path.join(directory,'checks/accept.mjs');
  fs.writeFileSync(frozenHelper,'process.exit(0);');
  assert.throws(()=>verifyEvaluatorAssets(cwd,directory,assets),/acceptance asset changed: checks\/accept.mjs/);
  fs.writeFileSync(frozenHelper,'process.exit(1);');
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), 'process.exit(1);');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"product","dependencies":{"cli":"1"},"devDependencies":{"review":"2"},"scripts":{"test":"node --test"}}');
  assert.throws(() => verifyEvaluatorAssets(cwd, directory, assets), /acceptance asset changed: package.json/);
  // Restoration refuses symlinked configuration and replaces hard links without writing through them.
  const outside = path.join(path.dirname(cwd), 'outside-package.json'), bytes = '{"name":"external","dependencies":{"cli":"2"}}\n';
  const packageFile = path.join(cwd, 'package.json');
  fs.writeFileSync(outside, bytes); fs.unlinkSync(packageFile); fs.symlinkSync(outside, packageFile);
  assert.throws(() => restoreEvaluatorAssets(cwd, directory, assets), /symlink path forbidden/);
  fs.unlinkSync(packageFile); fs.linkSync(outside, packageFile);
  restoreEvaluatorAssets(cwd, directory, assets);
  assert.equal(fs.readFileSync(outside, 'utf8'), bytes);
  assert.notEqual(fs.statSync(packageFile).ino, fs.statSync(outside).ino);
  assert.deepEqual(JSON.parse(read(cwd, 'package.json')).dependencies, { cli: '2' }, 'product dependencies stay mutable');
  verifyEvaluatorAssets(cwd, directory, assets);
});
