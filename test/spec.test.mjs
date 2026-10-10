import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HAPPY_PATH_CLAIMS, ASSERTION_PATH_PATTERN, MAX_ASSERTION_PATH_LENGTH, validateContract, validateProject, compare } from '../exitcode-spec.mjs';
import { contract, manifest, driver } from './helpers.mjs';

const claim = index => ({ id: `H${index}`, claim: `Observable user outcome ${index}` });
const invalid = value => assert.throws(() => validateContract(value), error => error.code === 'INVALID_SPEC');

test('happy-path claims are bounded, uniquely identified, nonempty records', () => {
  const valid = contract();
  const copy = validateContract(valid);
  assert.deepEqual(copy, valid);
  copy.happyPath[0].claim = 'Changed claim';
  copy.scenarios[0].covers.push('H2');
  assert.deepEqual(valid, contract());

  for (const happyPath of [undefined, null, 'The feature file contains done', {}, [],
    Array.from({ length: MAX_HAPPY_PATH_CLAIMS + 1 }, (_, index) => claim(index + 1)),
    [null], ['prose'], [{}], [{ claim: 'An outcome' }], [{ id: 'H1' }],
    [{ id: 'H1', claim: '' }], [{ id: 'H1', claim: '  ' }], [{ id: 'H1', claim: 1 }],
    [{ id: 'H1', claim: 'x'.repeat(8193) }], [{ ...claim(1), steps: [] }], [claim(1), claim(1)],
  ]) invalid({ ...contract(), happyPath });
  for (const id of ['', ' H1', 'H 1', 'H.1', 'x'.repeat(65), 1]) {
    invalid({ ...contract(), happyPath: [{ id, claim: 'An outcome' }] });
  }
});

test('scenario covers is required and references only declared happy-path claim IDs', () => {
  for (const covers of [undefined, null, 'H1', {}, [null], [1], [''], [' H1'], ['H2'], ['h1'],
    Array(MAX_HAPPY_PATH_CLAIMS + 1).fill('H1'),
  ]) {
    const value = contract(); value.scenarios[0].covers = covers;
    invalid(value);
  }
  const missing = contract(); delete missing.scenarios[0].covers;
  invalid(missing);
  const unknown = contract(); unknown.scenarios[0].covers = ['H1', 'H2'];
  assert.throws(() => validateContract(unknown), /Scenario feature: unknown happy-path claim H2/);
});

test('every declared happy-path claim needs scenario coverage', () => {
  const value = contract(); value.happyPath.push(claim(2));
  assert.throws(() => validateContract(value), /Happy-path claim H2 is not covered by any scenario/);
  const empty = contract(); empty.scenarios[0].covers = [];
  assert.throws(() => validateContract(empty), /Happy-path claim H1 is not covered by any scenario/);
});

test('one scenario can cover all eight claims without a criterion or scenario per claim', () => {
  const value = contract();
  value.happyPath = Array.from({ length: MAX_HAPPY_PATH_CLAIMS }, (_, index) => claim(index + 1));
  value.scenarios[0].covers = value.happyPath.map(claim => claim.id);
  assert.deepEqual(validateContract(value), value);
});

test('coverage supports many-to-many mappings and unmapped guardrails without baseline restrictions', () => {
  const value = contract(), scenario = value.scenarios[0];
  value.happyPath.push(claim(2), claim(3));
  scenario.covers = ['H1', 'H2'];
  value.scenarios.push({ ...structuredClone(scenario), id: 'existing-outcome', baseline: 'PASS', covers: ['H2', 'H3'] },
    { ...structuredClone(scenario), id: 'guardrail', baseline: 'PASS', covers: [] });
  assert.deepEqual(validateContract(value), value);
});

test('assertion schema and validator share pointer syntax without rewriting the observation root', () => {
  const pattern = new RegExp(ASSERTION_PATH_PATTERN);
  for (const pointer of ['/content', '/a~1b/~0key', '/', '/observations/content', '/line\nkey']) {
    const value = contract(); value.scenarios[0].assertions[0].path = pointer;
    assert.ok(pattern.test(pointer), pointer); validateContract(value);
  }
  for (const pointer of ['', 'observations.content', '/broken~2pointer', '/trailing~']) {
    const value = contract(); value.scenarios[0].assertions[0].path = pointer;
    assert.ok(!pattern.test(pointer), pointer); invalid(value);
  }
  const long = contract(); long.scenarios[0].assertions[0].path = '/' + 'x'.repeat(MAX_ASSERTION_PATH_LENGTH);
  invalid(long);
  assert.equal(compare({ retrieval: { found: false } }, [{ path: '/retrieval/found', op: 'eq', value: true }])[0].status, 'FAIL');
  assert.throws(() => compare({ retrieval: { found: false } }, [{ path: '/observations/retrieval/found', op: 'eq', value: true }]), /relative to the contents of observations/);
});

test('environment names reject runner-owned and process-control variables with named diagnostics', () => {
  const project = environment => ({ manifest: { ...manifest, environment }, files: { 'driver.mjs': driver } });
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', '', 'lowercase', 'VALID\n', 'WITH-DASH', null, {}]) {
    assert.throws(() => validateProject(project([key])), error => error.code === 'INVALID_SPEC' && error.message.includes(JSON.stringify(key)));
  }
  for (const environment of [[], ['RUSTUP_HOME', 'EXITCODE_TEST_SECRET', 'CI']]) {
    assert.deepEqual(validateProject(project(environment)), project(environment));
  }
});
