/** Evaluator quality, isolation, and frozen-evidence invariants. See INVARIANTS.md. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as core from './exitcode-core.mjs';
import { releasePreparation } from './exitcode-preparation.mjs';
import { REVIEW_MAX_TOKENS, callReview, reviewPrompt, reviewRepository, validateDerivation } from './exitcode-quality.mjs';
import { applyMutations, captureEvaluatorAssets, compileRecipe, restoreEvaluatorAssets, runRecipe, sandboxCommand, scanCapabilities, verifyEvaluatorAssets } from './exitcode-evaluator.mjs';
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
const literal = (extra = {}) => [{ id: 'C1', requirement: 'Feature is done', check: { recipe: { kind: 'file_contains', path: 'feature', value: 'done' } }, ...extra },
  { id: 'C2', requirement: 'Artifact persists', type: 'regression', check: { recipe: { kind: 'file_exists', path: 'feature' } } }];
async function prepare(cwd, criteria, overrides = {}, args = {}) {
  const io = core.makeIo(cwd, { review: structuralReview, ...overrides });
  const drafted = core.draftNode(io, { goal: 'Complete feature', criteria, ...args });
  assert.equal(drafted.ok, true, JSON.stringify(drafted.errors));
  return { io, result: await core.prepareNode(io) };
}
const codes = result => result.diagnostics.map(d => d.code);

// ---------------------------------------------------------------------------
// Independent semantic review: a behavioral scenario with scripted reviewers
// ---------------------------------------------------------------------------

const good = "const p={};export function save(v){if(v==='invalid')throw Error('invalid');p.zone=v;}export function get(){return p.zone;}";
const noop = "export function save(v){if(v==='invalid')throw Error('invalid');}export function get(){return undefined;}";
const hardcoded = "export function save(v){if(v==='invalid')throw Error('invalid');}export function get(){return 'Europe/London';}";
const observe = "import assert from 'node:assert/strict';import {save,get} from './store.mjs';assert.equal(get(),undefined);save('Europe/London');assert.equal(get(),'Europe/London');assert.throws(()=>save('invalid'));save('America/New_York');assert.equal(get(),'America/New_York');";

function scenario(t, mode = 'strong') {
  const cwd = workspace(t, { 'store.mjs': good, 'profile.txt': 'existing',
    'profile.test.mjs': "import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';test('profile artifact remains',()=>assert.equal(readFileSync('profile.txt','utf8'),'existing'));" });
  const criteria = [{ id: 'C1', requirement: 'Saving a timezone persists the selected value and rejects invalid input',
    check: { recipe: { kind: 'command_exit', command: 'node', args: ['--input-type=module', '-e', observe] } },
    controls: { accept: { mutations: [{ kind: 'write_file', path: 'store.mjs', content: good }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'store.mjs', content: noop }] }] } },
  { id: 'C2', requirement: 'Existing profile artifact remains', type: 'regression', check: { recipe: { kind: 'existing_test', path: 'profile.test.mjs', selector: 'profile artifact remains' } } }];
  const structural = mode === 'structural';
  if (mode === 'weak-file' || mode === 'empty-file') criteria[0].check = { recipe: { kind: 'file_exists', path: 'store.mjs' } };
  if (structural) {
    fs.writeFileSync(path.join(cwd, 'LICENSE'), 'MIT');
    Object.assign(criteria[0], { requirement: 'Package includes LICENSE', check: { recipe: { kind: 'file_exists', path: 'LICENSE' } } });
    delete criteria[0].controls;
  }
  // Thin contracts: the baseline is the positive witness and E0 supplies the negatives.
  if (mode === 'thin' || mode === 'thin-new-feature') delete criteria[0].controls;
  if (mode === 'new-feature' || mode === 'thin-new-feature') fs.unlinkSync(path.join(cwd, 'store.mjs'));
  const derived = { uncovered: [], criteria: [structural
    ? { criterionId: 'C1', observation: 'LICENSE is present', structural: true, nearMisses: [] }
    : { criterionId: 'C1', observation: 'Read the saved timezone back after each update',
      nearMisses: ['Keep exports but omit persistence', 'Return the first requested timezone for every update'],
      negative: 'Invalid input rejection is explicit', regression: 'Profile updates use the same path' }] };
  const assessed = { criteria: [{ criterionId: 'C1', outcomeObserved: true, negativeCovered: true, regressionCriteria: ['C2'],
    shams: structural ? [] : [{ id: 'C1.N1', mutations: [{ kind: 'write_file', path: 'store.mjs', content: noop }] }, { id: 'C1.N2', mutations: [{ kind: 'write_file', path: 'store.mjs', content: hardcoded }] }] }], issues: [] };
  const sham = assessed.criteria[0].shams[0];
  switch (mode) {
    case 'uncovered': derived.uncovered.push('Explicit unauthorized actor rejection'); break;
    case 'overlap': assessed.issues.push({ code: 'INTENT_REDUNDANT', criterionId: 'C1', evidence: 'Criteria restate the same outcome' }); break;
    case 'no-observation': assessed.criteria[0].outcomeObserved = false; break;
    case 'no-negative': assessed.criteria[0].negativeCovered = false; break;
    case 'no-regression': assessed.criteria[0].regressionCriteria = []; break;
    case 'irrelevant-regression': assessed.criteria[0].regressionCriteria = ['C1']; break;
    case 'duplicated-test': assessed.issues.push({ code: 'TEST_REUSE_MISSING', criterionId: 'C1', evidence: 'Custom shell duplicates discovered state tests' }); break;
    case 'no-sham': assessed.criteria[0].shams = []; break;
    case 'unchanged': sham.mutations[0].content = good; break;
    case 'setup-error': sham.mutations = [{ kind: 'replace_text', path: 'store.mjs', from: 'missing substring', to: 'bad' }]; break;
    case 'empty-file': sham.mutations[0].content = ''; break;
    case 'unsafe': sham.mutations[0].path = '../escape'; break;
    case 'test-mutation': sham.mutations[0].path = 'profile.test.mjs'; break;
    case 'malformed': assessed.criteria = []; break;
    case 'duplicate-assessment': assessed.criteria.push(assessed.criteria[0]); break;
    case 'too-many-shams': derived.criteria[0].nearMisses.push('excess'); break;
    case 'essay': derived.criteria[0].nearMisses = []; break;
  }
  const calls = [];
  const review = async (input, { signal }) => {
    assert.ok(signal instanceof AbortSignal); calls.push(input);
    if (mode === 'review-error') throw Error('provider failure');
    if (mode === 'review-timeout') return new Promise(() => {});
    if (input.phase === 'derive') {
      // Checks and controls are hidden from the first reviewer to avoid check-author bias.
      assert.deepEqual(input.criteria, criteria.map(c => ({ id: c.id, requirement: c.requirement, type: c.type ?? 'behavior' })));
      assert.ok(!JSON.stringify(input).includes('command_exit') && !JSON.stringify(input).includes('controls'));
      assert.ok(input.repository.capabilities.existingTests.includes('profile.test.mjs'));
      return derived;
    }
    assert.deepEqual(input.derived.criteria[0].nearMisses.map(n => n.id), derived.criteria[0].nearMisses.map((_, i) => `C1.N${i + 1}`));
    const witness = input.validFixtures[0];
    const store = witness.changed.find(f => f.path === 'store.mjs') ?? input.repository.files.find(f => f.path === 'store.mjs');
    if (!structural && !mode.startsWith('thin')) assert.equal(store.content, good, 'reviewer sees post-witness code');
    if (mode === 'strong') assert.deepEqual(witness.changed, [], 'unchanged witness files are not repeated');
    if (mode === 'new-feature') assert.deepEqual(witness.changed.map(f => f.path), ['store.mjs']);
    return assessed;
  };
  const io = core.makeIo(cwd, { ...(mode === 'missing-review' ? {} : { review }), reviewTimeoutMs: mode === 'review-timeout' ? 10 : 30000,
    ...(mode === 'runner-error' ? { exec: async (cmd, o) => { const r = await sandboxCommand(cmd, o); return r.exit === 1 ? { ...r, error: 'runner error' } : r; } } : {}) });
  assert.equal(core.draftNode(io, { goal: 'Timezone behavior', criteria,
    originalRequest: structural ? 'Include LICENSE' : 'Save timezone, reject invalid input and preserve profile updates' }).ok, true);
  return { cwd, io, calls };
}

test('semantic: adequate behavioral, structural, and thin evaluators reach approval with the candidate unchanged', async t => {
  for (const mode of ['strong', 'structural', 'new-feature', 'thin']) await t.test(mode, async t => {
    const { cwd, io, calls } = scenario(t, mode), before = core.digestTree(cwd), r = await core.prepareNode(io);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(core.digestTree(cwd), before);
    assert.equal(calls.length, 2);
    assert.equal(core.statusSnapshot(io).awaitingApproval, true);
    const probes = r.stages.find(s => s.stage === 'sham').probes;
    assert.equal(probes.length, mode === 'structural' ? 0 : 2);
    for (const p of probes) { assert.equal(p.outcome.status, 'FAIL'); assert.notEqual(p.fixtureDigest, before); }
    if (mode === 'structural') assert.ok(r.stages.find(s => s.stage === 'adversarial').probes.length > 0, 'built-ins get supervisor negatives');
    assert.match(r.review, mode === 'structural' ? /C1: file exists LICENSE/ : /rejected \d+ independent near-miss/);
    assert.equal(core.loadRoot(io, 'G1').approval, undefined);
  });
});

test('semantic: weak, uncovered, unchallenged, or malformed evaluators never reach approval', async t => {
  const expected = { 'weak-file': 'SHAM_SURVIVED', 'empty-file': 'SHAM_SURVIVED', uncovered: 'INTENT_UNCOVERED', overlap: 'INTENT_REDUNDANT',
    'no-observation': 'OUTCOME_NOT_OBSERVED', 'no-negative': 'NEGATIVE_COVERAGE_MISSING', 'no-regression': 'REGRESSION_UNRELATED',
    'irrelevant-regression': 'REGRESSION_UNRELATED', 'duplicated-test': 'TEST_REUSE_MISSING', 'no-sham': 'SHAM_MISSING', unchanged: 'SHAM_INVALID',
    'thin-new-feature': 'POSITIVE_WITNESS_REQUIRED', 'runner-error': 'RUNNER_ERROR' };
  for (const mode of [...Object.keys(expected), 'setup-error', 'unsafe', 'test-mutation', 'malformed', 'duplicate-assessment', 'too-many-shams', 'essay',
    'missing-review', 'review-error', 'review-timeout']) await t.test(mode, async t => {
    const { cwd, io } = scenario(t, mode), before = core.digestTree(cwd), r = await core.prepareNode(io);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.diagnostics.length);
    if (expected[mode]) assert.ok(codes(r).includes(expected[mode]), `${mode}: ${codes(r)}`);
    assert.equal(core.digestTree(cwd), before);
    assert.equal(r.review, undefined);
    assert.equal(core.statusSnapshot(io).awaitingApproval, false);
    assert.equal(core.approveRoot(io).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Thin evaluator drafts
// ---------------------------------------------------------------------------

test('witnesses: built-in recipes need no controls; other checks need a passing baseline or an authored witness', async t => {
  const thin = workspace(t);
  const { result } = await prepare(thin, literal());
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const accept = result.stages.find(s => s.stage === 'discrimination').probes.find(p => p.label === 'accept');
  assert.equal(accept.outcome.status, 'PASS', 'supervisor-generated positive witness');
  assert.ok(result.stages.find(s => s.stage === 'adversarial').probes.length >= 2, 'supervisor-generated negatives');
  for (const [label, value] of [['json', { kind: 'json_value', path: 'config.json', pointer: '/feature/enabled', value: true }],
    ['absence', { kind: 'file_not_contains', path: 'feature', value: 'pending' }]]) {
    const { result } = await prepare(workspace(t), [{ id: 'C1', requirement: `Generated ${label} witness`, check: { recipe: value } }, literal()[1]]);
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.diagnostics)}`);
  }
  // A custom check that already passes uses the candidate as its witness; one that cannot pass needs an authored witness.
  const command = (cmd, extra = {}) => [{ id: 'C1', requirement: 'Feature observed', check: { command: cmd }, controls: { reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] }, ...extra }, literal()[1]];
  const exec = async (cmd, { cwd }) => ({ exit: read(cwd, 'feature') === (cmd === 'observe-done' ? 'done' : 'pending') ? 0 : 1, stdout: '', stderr: '', timedOut: false });
  assert.equal((await prepare(workspace(t), command('observe-pending'), { exec })).result.ok, true);
  const missing = (await prepare(workspace(t), command('observe-done'), { exec })).result;
  assert.ok(codes(missing).includes('POSITIVE_WITNESS_REQUIRED'));
  assert.ok(!codes(missing).includes('NONDETERMINISTIC'), 'consequential repeat failures are not reported');
  assert.match(missing.diagnostics.find(d => d.code === 'POSITIVE_WITNESS_REQUIRED').recommendedRepair, /controls\.accept/);
  const authored = command('observe-done', { controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] } });
  assert.equal((await prepare(workspace(t), authored, { exec })).result.ok, true);
  // Without any reject witness or independent near-miss, a custom check has no negative evidence.
  const unchallenged = (await prepare(workspace(t), [{ id: 'C1', requirement: 'Feature observed', check: { command: 'observe-pending' } }, literal()[1]], { exec })).result;
  assert.ok(codes(unchallenged).includes('NEGATIVE_EVIDENCE_MISSING'));
});

test('witnesses: controls that resemble a reference implementation are rejected before review', async t => {
  const big = 'x'.repeat(70 * 1024), shared = 'y'.repeat(10 * 1024);
  const control = content => ({ accept: { mutations: [{ kind: 'write_file', path: 'feature', content }] } });
  for (const [label, criteria] of [
    ['bytes', literal({ controls: control(big) })],
    ['files', literal({ controls: { accept: { mutations: Array.from({ length: 17 }, (_, i) => ({ kind: 'write_file', path: `src/f${i}.mjs`, content: 'done' })) } } })],
    ['setup', literal({ controls: { accept: { setup: `printf done > feature # ${'z'.repeat(5000)}` } } })],
    ['repeated', [...literal({ controls: control(shared) }), { id: 'C3', requirement: 'Another outcome', check: { recipe: { kind: 'file_contains', path: 'feature', value: 'y' } }, controls: control(shared) }]],
  ]) {
    let reviews = 0;
    const { result } = await prepare(workspace(t), criteria, { review: async input => { reviews++; return structuralReview(input); } });
    const overbuilt = result.diagnostics.find(d => d.code === 'EVALUATOR_OVERBUILT');
    assert.ok(overbuilt, `${label}: ${codes(result)}`);
    assert.match(overbuilt.recommendedRepair, /minimal witness/);
    assert.equal(reviews, 0, `${label} never reaches semantic review`);
  }
});

// ---------------------------------------------------------------------------
// Review boundary: compact schemas, bounded context, cancellation
// ---------------------------------------------------------------------------

test('review: derivations are compact, clipped, and supervisor-numbered; responses and prompts are bounded', async () => {
  const criteria = [{ id: 'C1', requirement: 'r' }, { id: 'C2', requirement: 'q', type: 'regression' }];
  const { derived, diagnostics } = validateDerivation({ uncovered: ['missing outcome'],
    criteria: [{ criterionId: 'C1', observation: 'o'.repeat(5000), nearMisses: ['a', 'b'], negative: 'n' }] }, criteria);
  assert.deepEqual(derived.criteria[0].nearMisses.map(n => n.id), ['C1.N1', 'C1.N2']);
  assert.ok(derived.criteria[0].observation.length <= 300);
  assert.equal(derived.criteria[0].regression, undefined);
  assert.deepEqual(diagnostics.map(d => d.code), ['INTENT_UNCOVERED']);
  for (const bad of [{}, { criteria: [] }, { criteria: [{ criterionId: 'C1', observation: 'o', nearMisses: [] }] },
    { criteria: [{ criterionId: 'C1', observation: 'o', nearMisses: ['a', 'b', 'c'] }] }, { uncovered: 'x', criteria: [{ criterionId: 'C1', observation: 'o', structural: true }] }])
    assert.throws(() => validateDerivation(bad, criteria), e => e.code === 'REVIEW_RESPONSE_INVALID');
  assert.ok(REVIEW_MAX_TOKENS <= 4096);
  for (const phase of ['derive', 'assess']) assert.ok(reviewPrompt(phase).length < 2600, `${phase} prompt is compact`);
  await assert.rejects(callReview(() => ({ large: 'x'.repeat(70 * 1024) }), {}), /too large/);
});

test('review: repository context is bounded, excludes secrets and symlinks, and admits only declared hidden plans', t => {
  const cwd = workspace(t, { 'store.mjs': good, '.private/secret.mjs': 'private', 'credentials.json': 'secret', 'huge.mjs': 'x'.repeat(200000),
    '.agents/artifacts/plan.md': 'Required outcome: the store persists.', '.agents/artifacts/secret.md': 'api_key=supersecretcredential123456', '.agents/artifacts/extra.md': 'not selected' });
  fs.symlinkSync('/etc/passwd', path.join(cwd, 'link.mjs'));
  const repo = reviewRepository(cwd, scanCapabilities(cwd), [{ requirement: 'profile store' }], ['.agents/artifacts/plan.md', '.agents/artifacts/secret.md']);
  assert.ok(!repo.files.some(f => /private|credentials|link|secret|extra/.test(f.path)));
  assert.ok(repo.files.some(f => f.path === '.agents/artifacts/plan.md'));
  assert.deepEqual(repo.missingSpecifications, ['.agents/artifacts/secret.md']);
  assert.ok(repo.files.every(f => Buffer.byteLength(f.content) <= repo.limits.fileBytes));
  assert.ok(repo.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <= repo.limits.maxBytes);
  assert.ok(repo.files.find(f => f.path === 'huge.mjs').truncated);
});

test('review: cancellation aborts reviewers, optional watchdogs are bounded, and slow reviews are not cut off', async t => {
  const parent = new AbortController(); let nested;
  await assert.rejects(callReview(async (_input, { signal }) => { nested = signal; parent.abort(); return new Promise(() => {}); }, {}, { signal: parent.signal }), /cancelled/);
  assert.equal(nested.aborted, true);
  const already = new AbortController(); already.abort(); let calls = 0;
  await assert.rejects(callReview(() => { calls++; }, {}, { signal: already.signal }), e => e.code === 'CANCELLED');
  assert.equal(calls, 0);
  for (const timeoutMs of [0, -1, Infinity, NaN]) await assert.rejects(callReview(() => ({}), {}, { timeoutMs }), /finite and positive/);
  await assert.rejects(callReview(() => new Promise(() => {}), {}, { timeoutMs: 5 }), e => e.code === 'REVIEW_TIMEOUT');
  assert.equal(core.REVIEW_TIMEOUT_MS, null);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let slowSignal;
  const slow = callReview((_input, { signal }) => { slowSignal = signal; return new Promise(resolve => setTimeout(() => resolve({ reviewed: true }), 45000)); }, {});
  await Promise.resolve();
  t.mock.timers.tick(45000);
  assert.deepEqual(await slow, { reviewed: true });
  assert.equal(slowSignal.aborted, false);
});

// ---------------------------------------------------------------------------
// Mechanical discrimination
// ---------------------------------------------------------------------------

test('discrimination: overfitted rejects, duplicates, false positives, and inconclusive setups never reach review', async t => {
  const overfitted = literal({ controls: { reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }] } });
  const cwd = workspace(t);
  const { io, result } = await prepare(cwd, overfitted);
  assert.ok(codes(result).includes('REJECT_NOT_DISCRIMINATED'));
  assert.equal(core.approveRoot(io).ok, false);
  assert.equal(core.draftNode(io, { goal: 'Complete feature', criteria: literal(), revise: 'G1' }).ok, true);
  assert.equal((await core.prepareNode(io)).ok, true, 'repair precedes review without spending execution');
  assert.equal(core.statusSnapshot(io).consumedAttempts, 0);
  const duplicate = literal(); duplicate[1].requirement = duplicate[0].requirement;
  assert.ok(codes((await prepare(workspace(t), duplicate)).result).includes('DUPLICATE_CRITERION'));
  // Empty-target wiring: a check that passes against nothing proves nothing.
  const always = async () => ({ exit: 0, stdout: '', stderr: '', timedOut: false });
  assert.ok(codes((await prepare(workspace(t), [literal()[0], { ...literal()[1], check: { command: 'always' } }], { exec: always })).result).includes('EMPTY_TARGET_PASS'));
  // Setup failures and ERROR outcomes are never rejection evidence.
  for (const failure of [{ exit: 1 }, { timedOut: true }, { error: 'unavailable' }]) {
    const exec = async (cmd, { cwd }) => cmd === 'broken-setup' ? { exit: 0, stdout: '', stderr: '', timedOut: false, ...failure }
      : { exit: read(cwd, 'feature') === 'done' ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    const criteria = [{ id: 'C1', requirement: 'Feature observed', check: { command: 'observe' }, controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ setup: 'broken-setup' }] } }, literal()[1]];
    const r = (await prepare(workspace(t), criteria, { exec })).result;
    assert.equal(r.ok, false, JSON.stringify(failure));
    assert.ok(!codes(r).includes('REJECT_NOT_DISCRIMINATED'), JSON.stringify(codes(r)));
  }
  const external = (await prepare(workspace(t), [{ ...literal()[0], check: { command: 'curl https://example.com' } }, literal()[1]])).result;
  assert.ok(codes(external).includes('EXTERNAL_DEPENDENCY'));
});

test('discrimination: inconsistent outcomes fail determinism, but harmless stdout variation does not', async t => {
  let n = 0;
  const flaky = async (_cmd, { cwd }) => ({ exit: read(cwd, 'feature') === 'done' && ++n % 2 === 1 ? 0 : 1, stdout: '', stderr: '', timedOut: false });
  const criteria = [{ id: 'C1', requirement: 'Feature observed', check: { command: 'observe' }, controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'pending' }] }] } }, literal()[1]];
  assert.ok(codes((await prepare(workspace(t), criteria, { exec: flaky })).result).includes('NONDETERMINISTIC'));
  let count = 0;
  const timing = async (_cmd, { cwd }) => ({ exit: read(cwd, 'feature') === 'done' ? 0 : 1, stdout: `elapsed ${++count}ms`, stderr: '', timedOut: false });
  assert.equal((await prepare(workspace(t), criteria, { exec: timing })).result.ok, true);
});

test('recipes: selectors must be literal and discovered, discovery never executes code, and paths stay confined', async t => {
  const cwd = workspace(t, { 'test/a.test.mjs': "import {test} from 'node:test';test('works',()=>{});",
    'package.json': JSON.stringify({ scripts: { test: 'touch leaked' } }), 'value.json': '{}' });
  const cap = scanCapabilities(cwd);
  assert.equal(cap.availableScripts.test, 'touch leaked');
  assert.equal(fs.existsSync(path.join(cwd, 'leaked')), false);
  assert.throws(() => compileRecipe({ kind: 'existing_test', path: 'test/a.test.mjs', selector: 'absent' }, cap), /TEST_SELECTOR_NOT_FOUND/);
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

test('isolation: checks cannot see host paths, env, or processes and may write only their own fixture', async t => {
  const cwd = workspace(t);
  process.env.EXITCODE_TEST_SECRET = 'hidden';
  try {
    const js = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(cwd)})||process.env.EXITCODE_TEST_SECRET||fs.existsSync('/proc/${process.pid}/root'))process.exit(9);console.log('isolated');`;
    const result = await sandboxCommand('node -e ' + JSON.stringify(js), { cwd, timeoutMs: 5000 });
    assert.equal(result.exit, 0, JSON.stringify(result));
    assert.equal((await sandboxCommand('echo unsafe', { cwd, timeoutMs: 1000, bwrapPath: '/nonexistent/bwrap' })).exit, null);
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

test('identity: stale candidates, environments, or evidence invalidate approval; fresh evaluation bypasses the cache', async t => {
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
  assert.equal(warm.metrics.reviewCalls, 2, 'warm preparation still performs independent review');
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
  assert.equal(core.draftNode(io, { goal: 'Complete feature', criteria, ...args }).ok, true);
  const prepared = await core.prepareNode(io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostics));
  assert.equal(core.approveRoot(io).ok, true);
  assert.equal((await core.sealNode(io, 'G1')).ok, true);
  return { cwd, io };
}

test('assets: acceptance helpers and test inventory freeze while imported product source stays mutable', async t => {
  const source = "import{readFileSync}from'node:fs';export const value=()=>readFileSync('feature','utf8');";
  const helper = "import{value}from'../src/product.mjs';process.exit(value()==='done'?0:1);";
  const criteria = [{ id: 'C1', requirement: 'The product reports done', check: { command: 'node checks/accept.mjs', assets: ['checks/accept.mjs'] },
    controls: { accept: { mutations: [{ kind: 'write_file', path: 'feature', content: 'done' }] }, reject: [{ mutations: [{ kind: 'write_file', path: 'feature', content: 'broken' }] }] } }, literal()[1]];
  const { cwd, io } = await sealed(t, { 'src/product.mjs': source, 'checks/accept.mjs': helper, 'tests/mandatory.test.mjs': 'export const mandatory=true;' }, criteria);
  const bundle = core.loadBundle(io, 'G1');
  assert.ok(bundle.assets.files.some(f => f.path === 'checks/accept.mjs'));
  assert.ok(!bundle.assets.files.some(f => f.path === 'src/product.mjs'));
  fs.writeFileSync(path.join(cwd, 'src/product.mjs'), source + '\n// Permitted product implementation change.\n');
  fs.writeFileSync(path.join(cwd, 'feature'), 'done');
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), 'process.exit(0);');
  assert.equal((await core.evaluateNode(io)).pause.code, 'EVALUATOR_DRIFT');
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), helper);
  assert.equal(core.resumeRoot(io).ok, true);
  fs.writeFileSync(path.join(cwd, 'tests/new.test.mjs'), 'export const newCase=true;');
  assert.equal((await core.evaluateNode(io)).pause.code, 'EVALUATOR_DRIFT');
  fs.rmSync(path.join(cwd, 'tests/new.test.mjs'));
  assert.equal(core.resumeRoot(io).ok, true);
  assert.equal((await core.evaluateNode(io)).status, 'PASS');
});

test('assets: the evaluator package closure stays frozen while approved product dependencies change', async t => {
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
  fs.writeFileSync(path.join(cwd, 'node_modules/shared/assert.mjs'), 'export const assertion=0;');
  assert.equal((await core.evaluateNode(io)).pause.code, 'EVALUATOR_DRIFT');
  fs.writeFileSync(path.join(cwd, 'node_modules/shared/assert.mjs'), 'export const assertion=1;');
  assert.equal(core.resumeRoot(io).ok, true);
  // An optional dependency becoming available changes evaluator resolution.
  fs.mkdirSync(path.join(cwd, 'node_modules/optional'));
  fs.writeFileSync(path.join(cwd, 'node_modules/optional/package.json'), '{"name":"optional"}');
  assert.equal((await core.evaluateNode(io)).pause.code, 'EVALUATOR_DRIFT');
  fs.rmSync(path.join(cwd, 'node_modules/optional'), { recursive: true });
  assert.equal(core.resumeRoot(io).ok, true);
  fs.writeFileSync(path.join(cwd, 'feature'), 'done');
  assert.equal((await core.evaluateNode(io)).status, 'PASS');
});

test('assets: capture canonicalizes declared paths, pins runtimes and configuration, and restoration never writes outside', t => {
  const cwd = workspace(t, { feature: 'pending', 'checks/accept.mjs': 'process.exit(1);', 'checks/fixtures/expected.json': '{"valid":true}',
    'package.json': '{"name":"product","dependencies":{"cli":"1"},"devDependencies":{"review":"1"},"scripts":{"test":"node --test"}}',
    'node_modules/cli/package.json': '{"name":"cli","bin":{"cli":"bin.mjs"}}', 'node_modules/cli/bin.mjs': 'process.exit(0);', 'node_modules/review/package.json': '{"name":"review"}' });
  fs.mkdirSync(path.join(cwd, 'node_modules/.bin'));
  fs.symlinkSync('../cli/bin.mjs', path.join(cwd, 'node_modules/.bin/cli'));
  const draft = { criteria: [{ id: 'C1', check: { command: 'node checks/accept.mjs', assets: ['./checks//accept.mjs', './checks/fixtures/'] } }], mutableDependencies: true };
  const directory = path.join(cwd, '.exitcode/assets/test');
  const assets = captureEvaluatorAssets(cwd, draft, directory);
  for (const file of ['checks/accept.mjs', 'checks/fixtures/expected.json', 'node_modules/cli/bin.mjs']) assert.ok(assets.files.some(f => f.path === file), file);
  assert.ok(assets.directories.includes('checks/fixtures'));
  verifyEvaluatorAssets(cwd, directory, assets);
  fs.writeFileSync(path.join(cwd, 'checks/accept.mjs'), 'process.exit(0);');
  assert.throws(() => verifyEvaluatorAssets(cwd, directory, assets), /acceptance asset changed: checks\/accept.mjs/);
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
