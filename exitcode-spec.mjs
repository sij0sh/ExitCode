import { fail, relative, stable } from './exitcode-files.mjs';

export const OPS = ['eq', 'lte', 'gte', 'contains', 'present'];
export const MAX_HAPPY_PATH_CLAIMS = 8;
export const ASSERTION_PATH_PATTERN = '^/(?:[^~]|~[01])*$';
export const MAX_ASSERTION_PATH_LENGTH = 512;
const assertionPath = new RegExp(ASSERTION_PATH_PATTERN);
const safeEnvironmentName = key => typeof key === 'string' && key === key.trim() && /^[A-Z][A-Z0-9_]*$/.test(key)
  && !/^(PATH|HOME|TMPDIR|TEMP|TMP|NODE_OPTIONS|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS)$/.test(key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 8192) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_SPEC', `${label} must be nonempty text, at most ${max} characters`);
};
const keys = (value, allowed, label) => {
  if (!record(value)) fail('INVALID_SPEC', `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_SPEC', `${label}: unknown field ${key}`);
};
const id = (value, label) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('INVALID_SPEC', `${label} must be a short identifier`); };
const seconds = (value, label) => { if (!Number.isFinite(value) || value <= 0 || value > 86400) fail('INVALID_SPEC', `${label} must be between 0 and 86400 seconds`); };
const json = (value, label) => {
  if (value === undefined || Buffer.byteLength(stable(value)) > 128 * 1024) fail('INVALID_SPEC', `${label} must be JSON within 128 KiB`);
  const visit = item => {
    if (typeof item === 'number' && !Number.isFinite(item) || ['function', 'symbol', 'bigint', 'undefined'].includes(typeof item)) fail('INVALID_SPEC', `${label} contains a non-JSON value`);
    if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child);
  };
  visit(value);
};

export function validateProject(project) {
  keys(project, ['manifest', 'files'], 'project');
  const m = project.manifest;
  keys(m, ['protocol', 'name', 'command', 'timeoutSeconds', 'environment', 'isolation'], 'manifest');
  if (m.protocol !== 1) fail('UNSUPPORTED_FORMAT', 'Only project protocol 1 is supported');
  text(m.name, 'project name', 128);
  keys(m.command, ['program', 'args'], 'command');
  text(m.command.program, 'command program', 512);
  if (!Array.isArray(m.command.args) || m.command.args.length > 32 || m.command.args.some(arg => typeof arg !== 'string' || arg.length > 4096)) fail('INVALID_SPEC', 'command.args must be at most 32 strings');
  seconds(m.timeoutSeconds, 'timeoutSeconds');
  if (!['workspace', 'bubblewrap'].includes(m.isolation)) fail('INVALID_SPEC', 'Choose workspace or bubblewrap isolation explicitly; there is no fallback');
  if (!Array.isArray(m.environment) || m.environment.length > 32) fail('INVALID_SPEC', 'environment must contain at most 32 additional safe variable names; start with environment: []');
  const rejected = m.environment.filter(key => !safeEnvironmentName(key));
  if (rejected.length) fail('INVALID_SPEC', `Rejected environment names: ${rejected.map(key => JSON.stringify(key)?.slice(0, 128)).join(', ')}. PATH, HOME and TMPDIR are runner-owned; start with environment: [].`);
  keys(project.files, Object.keys(project.files ?? {}), 'project.files');
  if (!Object.keys(project.files).length || Object.keys(project.files).length > 64) fail('INVALID_SPEC', 'Provide 1 to 64 project driver files');
  let bytes = 0;
  for (const [name, content] of Object.entries(project.files)) {
    relative(name);
    if (typeof content !== 'string') fail('INVALID_SPEC', 'Driver files must be UTF-8 text');
    bytes += Buffer.byteLength(content);
  }
  if (bytes > 2 * 1024 * 1024) fail('INVALID_SPEC', 'Project driver exceeds 2 MiB');
  return structuredClone(project);
}

export function validateContract(contract) {
  keys(contract, ['version', 'problem', 'happyPath', 'constraints', 'scenarios'], 'contract');
  if (Buffer.byteLength(stable(contract)) > 64 * 1024) fail('INVALID_SPEC', 'Contract exceeds 64 KiB; keep fixtures in the reusable project driver');
  if (contract.version !== 1) fail('UNSUPPORTED_FORMAT', 'Only contract version 1 is supported');
  text(contract.problem, 'problem');
  if (!Array.isArray(contract.happyPath) || !contract.happyPath.length || contract.happyPath.length > MAX_HAPPY_PATH_CLAIMS) fail('INVALID_SPEC', `Provide 1 to ${MAX_HAPPY_PATH_CLAIMS} happy-path claims`);
  const claims = new Set(), covered = new Set();
  for (const claim of contract.happyPath) {
    keys(claim, ['id', 'claim'], 'happy-path claim');
    id(claim.id, 'happy-path claim id'); text(claim.claim, 'happy-path claim');
    if (claims.has(claim.id)) fail('INVALID_SPEC', `Duplicate happy-path claim ${claim.id}`);
    claims.add(claim.id);
  }
  if (!Array.isArray(contract.constraints) || contract.constraints.length > 16 || contract.constraints.some(c => typeof c !== 'string' || !c.trim() || c.length > 2048)) fail('INVALID_SPEC', 'constraints must be at most 16 nonempty strings');
  if (!Array.isArray(contract.scenarios) || !contract.scenarios.length || contract.scenarios.length > 16) fail('INVALID_SPEC', 'Provide 1 to 16 scenarios');
  const seen = new Set();
  for (const scenario of contract.scenarios) {
    keys(scenario, ['id', 'covers', 'description', 'instructions', 'input', 'baseline', 'trials', 'timeoutSeconds', 'assertions'], 'scenario');
    id(scenario.id, 'scenario id');
    if (seen.has(scenario.id)) fail('INVALID_SPEC', `Duplicate scenario ${scenario.id}`);
    seen.add(scenario.id);
    if (!Array.isArray(scenario.covers) || scenario.covers.length > MAX_HAPPY_PATH_CLAIMS) fail('INVALID_SPEC', `Scenario ${scenario.id}: covers must be an array of at most ${MAX_HAPPY_PATH_CLAIMS} claim IDs`);
    for (const claimId of scenario.covers) {
      id(claimId, `Scenario ${scenario.id} covers`);
      if (!claims.has(claimId)) fail('INVALID_SPEC', `Scenario ${scenario.id}: unknown happy-path claim ${claimId}`);
      covered.add(claimId);
    }
    text(scenario.description, 'scenario description'); text(scenario.instructions, 'scenario instructions'); json(scenario.input, 'scenario input');
    if (!['FAIL', 'PASS'].includes(scenario.baseline)) fail('INVALID_SPEC', 'baseline must declare FAIL for reproduction or PASS for an existing guardrail');
    if (!Number.isInteger(scenario.trials) || scenario.trials < 1 || scenario.trials > 20) fail('INVALID_SPEC', 'trials must be between 1 and 20; every scheduled trial must pass');
    seconds(scenario.timeoutSeconds, 'scenario timeoutSeconds');
    if (!Array.isArray(scenario.assertions) || !scenario.assertions.length || scenario.assertions.length > 32) fail('INVALID_SPEC', 'Provide 1 to 32 assertions per scenario');
    for (const assertion of scenario.assertions) {
      keys(assertion, ['path', 'op', 'value'], 'assertion');
      if (typeof assertion.path !== 'string' || !assertionPath.test(assertion.path) || assertion.path.length > MAX_ASSERTION_PATH_LENGTH)
        fail('INVALID_SPEC', `assertion.path must be a JSON pointer within ${MAX_ASSERTION_PATH_LENGTH} characters, relative to the contents of observations (e.g. /retrieval/found)`);
      if (!OPS.includes(assertion.op)) fail('INVALID_SPEC', `Unsupported assertion operator ${assertion.op}`);
      if (assertion.op === 'present') { if (Object.hasOwn(assertion, 'value')) fail('INVALID_SPEC', 'present has no value'); }
      else json(assertion.value, 'assertion value');
      if (['lte', 'gte'].includes(assertion.op) && !Number.isFinite(assertion.value)) fail('INVALID_SPEC', 'Numeric comparison requires a finite number');
      if (assertion.op === 'contains' && (typeof assertion.value !== 'string' || !assertion.value)) fail('INVALID_SPEC', 'contains requires a nonempty string');
    }
  }
  for (const claimId of claims) if (!covered.has(claimId)) fail('INVALID_SPEC', `Happy-path claim ${claimId} is not covered by any scenario`);
  return structuredClone(contract);
}

export function compare(observations, assertions) {
  if (!record(observations)) fail('INVALID_OBSERVATION', 'observations must be an object');
  json(observations, 'observations');
  return assertions.map(assertion => {
    let actual = observations, found = true;
    for (const part of assertion.path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (!actual || typeof actual !== 'object' || !Object.hasOwn(actual, part)) { found = false; break; }
      actual = actual[part];
    }
    // Missing required measurements and type mismatches are inconclusive, never successful failures.
    if (!found && assertion.op !== 'present') fail('INVALID_OBSERVATION', `Missing observation ${assertion.path}; assertion pointers are relative to the contents of observations`);
    if (['lte', 'gte'].includes(assertion.op) && !Number.isFinite(actual)) fail('INVALID_OBSERVATION', `Expected a finite number at ${assertion.path}`);
    if (assertion.op === 'contains' && typeof actual !== 'string') fail('INVALID_OBSERVATION', `Expected text at ${assertion.path}`);
    const pass = assertion.op === 'present' ? found : assertion.op === 'eq' ? stable(actual) === stable(assertion.value)
      : assertion.op === 'lte' ? actual <= assertion.value : assertion.op === 'gte' ? actual >= assertion.value : actual.includes(assertion.value);
    return { ...assertion, actual: found ? actual : null, status: pass ? 'PASS' : 'FAIL' };
  });
}
