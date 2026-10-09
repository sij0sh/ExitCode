/** Proof DAGs and speculative candidates. Pi session mechanics are injected. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inventory, candidateIdentity, criterionRequirement, evaluatorEnvironment, compatibleEnvironment, digest } from './exitcode-evaluator.mjs';
import { ensureRunning, operationError, operationSignal, abortable } from './exitcode-operation.mjs';

const execute = promisify(execFile);
const oid = /^[0-9a-f]{40,64}$/;

function gitEnvironment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'ExitCode', GIT_AUTHOR_EMAIL: 'exitcode@localhost', GIT_COMMITTER_NAME: 'ExitCode', GIT_COMMITTER_EMAIL: 'exitcode@localhost', ...extra };
}

/** Read capability information without creating repos, sessions, or candidates. */
export async function preflightExecution(io, executeGit = execute) {
  ensureRunning(io.signal, io.deadlineAt, io.nowMs);
  try {
    const result = await executeGit('git', ['merge-tree', '--write-tree', '--name-only', '-z', '--merge-base=HEAD', '-h'],
      {signal:io.signal, env:gitEnvironment(), timeout:10_000});
    checkGit(result);
  } catch (error) {
    ensureRunning(io.signal, io.deadlineAt, io.nowMs);
    // Git prints usage with exit 129 even when the required form is supported.
    if (error.code === 129) checkGit(error);
    else throw operationError('GIT_UNAVAILABLE', error.message);
  }
  const backend = io.workerBackend;
  if (!backend || ['preflight','start','send','cancel','dispose'].some(k=>typeof backend[k] !== 'function'))
    throw operationError('WORKER_UNAVAILABLE', 'independent worker backend with capability preflight unavailable');
  const operation = operationSignal(io.signal,{timeoutMs:10_000});
  try { await abortable(()=>backend.preflight({signal:operation.signal}),operation.signal); }
  catch (error) {
    if(error.code==='CHECK_TIMEOUT')throw operationError('WORKER_UNAVAILABLE','worker capability preflight timed out');
    throw error;
  }
  finally { operation.dispose(); }
  ensureRunning(io.signal, io.deadlineAt, io.nowMs);
}

function checkGit(result) {
  const usage = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!usage.includes('--write-tree') || !/--(?:\[no-\])?merge-base/.test(usage) || /unknown option/.test(usage))
    throw operationError('GIT_UNAVAILABLE', 'Git requires merge-tree --write-tree --merge-base support');
}

export function validateExecution(draft) {
  const errors = [], slices = draft.execution;
  if (slices === undefined) return errors;
  if (draft.parent) errors.push('execution is root-only');
  if (draft.sequence !== undefined) errors.push('use execution or legacy sequence, not both');
  if (!Array.isArray(slices) || !slices.length || slices.length > 12) return [...errors, 'execution must contain 1-12 slices'];
  const behavior = new Set((Array.isArray(draft.criteria) ? draft.criteria : []).filter(c => c && (c.type ?? 'behavior') === 'behavior').map(c => c.id));
  const owners = new Map(), ids = new Set();
  for (const [i, slice] of slices.entries()) {
    if (!slice || typeof slice !== 'object') { errors.push(`execution[${i}] must be an object`); continue; }
    if (typeof slice.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(slice.id) || ids.has(slice.id)) errors.push(`execution[${i}].id must be a unique safe identifier`);
    ids.add(slice.id);
    if (typeof slice.objective !== 'string' || !slice.objective.trim() || slice.objective.trim().length > 200) errors.push(`execution[${i}].objective must contain 1-200 characters`);
    if (!Array.isArray(slice.verify) || !slice.verify.length) errors.push(`execution[${i}].verify must name behavior criteria`);
    else for (const criterion of slice.verify) {
      if (!behavior.has(criterion)) errors.push(`execution[${i}].verify references unknown behavior criterion ${criterion}`);
      if (owners.has(criterion)) errors.push(`criterion ${criterion} appears in more than one execution slice`);
      owners.set(criterion, i);
    }
    if (slice.after !== undefined && (!Array.isArray(slice.after) || slice.after.some(c => !behavior.has(c)))) errors.push(`execution[${i}].after must name valid behavior criteria`);
  }
  for (const criterion of behavior) if (!owners.has(criterion)) errors.push(`behavior criterion ${criterion} is missing from execution`);
  const visiting = new Set(), done = new Set();
  const visit = i => {
    if (visiting.has(i)) { errors.push('execution dependencies contain a cycle'); return; }
    if (done.has(i)) return;
    visiting.add(i);
    for (const criterion of Array.isArray(slices[i]?.after) ? slices[i].after : []) if (owners.has(criterion)) visit(owners.get(criterion));
    visiting.delete(i); done.add(i);
  };
  slices.forEach((_, i) => visit(i));
  return errors;
}

export function workerBehaviorHorizon(contract, sliceId) {
  const wanted = new Set();
  const owners = new Map(contract.execution.flatMap(s => s.verify.map(c => [c, s]))), seen = new Set();
  const add = slice => {
    if (!slice || seen.has(slice.id)) return;
    seen.add(slice.id);
    slice.verify.forEach(c => wanted.add(c));
    (slice.after ?? []).forEach(c => add(owners.get(c)));
  };
  add(contract.execution.find(s => s.id === sliceId));
  return contract.criteria.filter(c => wanted.has(c.id)).map(c => c.id);
}

/** Integration always proves global regressions alongside cumulative behavior. */
export function integrationHorizon(contract, behaviorIds) {
  const wanted = new Set(behaviorIds);
  return contract.criteria.filter(c => c.type === 'regression' || wanted.has(c.id)).map(c => c.id);
}

/** Diagnostic counters never authorize proof or scheduler transitions. */
export function executionMetrics(state) {
  const metrics = state.metrics ??= {};
  for (const key of ['workerStarts', 'workerTurns', 'workerMs', 'evaluationRuns', 'evaluationMs', 'proofReuseHits', 'mergeCount', 'reconciliationTurns', 'totalMs']) metrics[key] ??= 0;
  metrics.criteria ??= {};
  return metrics;
}

export function recordExecutionEvaluation(state, result, durationMs) {
  const metrics = executionMetrics(state);
  metrics.evaluationRuns++; metrics.evaluationMs += durationMs;
  for (const outcome of result.outcomes) {
    const criterion = metrics.criteria[outcome.criterionId] ??= { runs: 0, durationMs: 0 };
    criterion.runs++; criterion.durationMs += outcome.durationMs ?? 0;
  }
}

/** No command reads worker Git metadata, user configuration, hooks, or refs. */
async function git(repo, args, io, input, extraEnv = {}) {
  ensureRunning(io.signal, io.deadlineAt, io.nowMs);
  const result = await new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '--git-dir', repo, ...args],
      { env: gitEnvironment(extraEnv), signal: io.signal, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  ensureRunning(io.signal, io.deadlineAt, io.nowMs);
  if (result.code !== 0 && !(args[0] === 'merge-tree' && result.code === 1)) throw operationError('GIT_FAILED', result.stderr.slice(-2000) || `git ${args[0]} exited ${result.code}`);
  return result;
}

function gitQuote(value) {
  return '"' + Buffer.from(value).reduce((s, byte) => s + (byte === 34 || byte === 92 ? '\\' + String.fromCharCode(byte) : byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : String.fromCharCode(byte)), '') + '"';
}

/** A temporary index builds the exact candidate without touching the user's index. */
export async function captureCandidate(repo, cwd, parents, io) {
  const before = candidateIdentity(cwd, io), index = path.join(path.dirname(repo), `index-${randomUUID()}`);
  const entries = inventory(cwd, { ...io, dependencies: true });
  try {
    const lines = [];
    const regular = entries.filter(e => e.link === undefined);
    const hashes = regular.length ? (await git(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], io,
      regular.map(e => gitQuote(e.full)).join('\n') + '\n')).stdout.trim().split('\n') : [];
    let i = 0;
    for (const entry of entries) {
      const hash = entry.link === undefined ? hashes[i++] : (await git(repo, ['hash-object', '-w', '--stdin'], io, Buffer.from(entry.link))).stdout.trim();
      if (!oid.test(hash)) throw operationError('GIT_FAILED', 'invalid blob identity');
      const mode = entry.link !== undefined ? '120000' : entry.mode & 0o111 ? '100755' : '100644';
      lines.push(`${mode} ${hash}\t${entry.rel}\0`);
    }
    await git(repo, ['update-index', '-z', '--index-info'], io, lines.join(''), { GIT_INDEX_FILE: index });
    const tree = (await git(repo, ['write-tree'], io, undefined, { GIT_INDEX_FILE: index })).stdout.trim();
    const tip = (await git(repo, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p])], io, 'ExitCode candidate\n')).stdout.trim();
    await git(repo, ['update-ref', `refs/heads/candidate-${tip}`, tip], io);
    if (candidateIdentity(cwd, io) !== before) throw operationError('CANDIDATE_MUTATED', 'candidate changed during Git capture');
    return { tip, tree, digest: before, modes: Object.fromEntries(regular.map(e => [e.rel, e.mode])) };
  } finally { fs.rmSync(index, { force: true }); fs.rmSync(`${index}.lock`, { force: true }); }
}

export async function materialize(repo, artifact, cwd, io) {
  if (!oid.test(artifact.tip) || !oid.test(artifact.tree)) throw operationError('CANDIDATE_INVALID', 'invalid candidate identity');
  if ((await git(repo, ['rev-parse', `${artifact.tip}^{tree}`], io)).stdout.trim() !== artifact.tree) throw operationError('CANDIDATE_INVALID', 'candidate tip does not name its exact tree');
  await execute('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-checkout', '--template=', repo, cwd],
    { signal: io.signal, env: gitEnvironment() });
  await git(path.join(cwd, '.git'), ['--work-tree', cwd, 'checkout', '--force', '--detach', artifact.tip], io);
  await git(path.join(cwd, '.git'), ['config', '--remove-section', 'remote.origin'], io);
  for (const [rel, mode] of Object.entries(artifact.modes)) {
    const full = path.join(cwd, rel);
    if (fs.existsSync(full) && !fs.lstatSync(full).isSymbolicLink()) fs.chmodSync(full, mode);
  }
  if (artifact.digest && candidateIdentity(cwd, io) !== artifact.digest) throw operationError('CANDIDATE_INVALID', 'materialized Git tree differs from its verified candidate');
  return cwd;
}

export async function createExecution(io, root, bundle) {
  const directory = path.join(io.cwd, '.exitcode', 'parallel', root.id);
  fs.mkdirSync(directory, { recursive: true });
  const repo = path.join(directory, `objects-${randomUUID()}.git`);
  await execute('git', ['init', '--bare', '--template=', repo], { signal: io.signal, env: gitEnvironment() });
  const base = await captureCandidate(repo, io.cwd, [], io);
  if (base.digest !== bundle.candidateDigest) throw operationError('CANDIDATE_MUTATED', 'approved candidate changed while creating execution base');
  await git(repo, ['update-ref', 'refs/heads/candidates', base.tip], io);
  return { directory, repo, base, integrated: base, phase: 'SCHEDULING',
    slices: bundle.contract.execution.map(s => ({ id: s.id, status: 'PENDING' })), evidence: null, reconciliation: null };
}

async function merge(repo, base, ours, theirs, io) {
  const result = await git(repo, ['merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${base.tip}`, ours.tip, theirs.tip], io);
  const parts = result.stdout.split('\0'), tree = parts.shift();
  if (!oid.test(tree)) throw operationError('GIT_FAILED', 'merge did not produce an exact tree');
  const tip = (await git(repo, ['commit-tree', tree, '-p', ours.tip, '-p', theirs.tip], io, 'ExitCode integration\n')).stdout.trim();
  await git(repo, ['update-ref', `refs/heads/candidate-${tip}`, tip], io);
  const combined = { ...ours.modes };
  for (const [rel, mode] of Object.entries(theirs.modes)) if (mode !== base.modes[rel] || combined[rel] === undefined) combined[rel] = mode;
  return { artifact: { tip, tree, modes: combined }, conflictPaths: result.code === 1 ? parts.slice(0, parts.indexOf('')) : [],
    conflicts: result.code === 1 ? parts.filter(Boolean).join('\n').slice(0, 12000) : null };
}

function unresolvedConflicts(record, io) {
  const files = new Map(inventory(record.cwd, {...io,dependencies:true}).map(f => [f.rel,f]));
  return (record.context.conflictPaths ?? []).filter(rel => {
    const entry = files.get(rel);
    if (!entry || entry.link !== undefined) return false;
    const text = fs.readFileSync(entry.full,'utf8');
    return text.includes(`<<<<<<< ${record.context.ours}`) || text.includes(`>>>>>>> ${record.context.theirs}`);
  });
}

function prompt(contract, slice, failures) {
  const ids = new Set(workerBehaviorHorizon(contract, slice.id));
  return { objective: slice.objective, rootGoal: contract.goal, assumptions: contract.assumptions ?? [], exclusions: contract.exclusions ?? [],
    criteria: contract.criteria.filter(c => ids.has(c.id)).map(c => ({ id:c.id, requirement:criterionRequirement(contract,c), type:c.type })),
    regressions: contract.criteria.filter(c => c.type === 'regression').map(c => ({id:c.id, requirement:criterionRequirement(contract,c)})), failures };
}

/** One locked supervisor; workers only return settled candidates, never verdicts. */
export async function runExecution(io, root, bundle, host) {
  const state = root.execution, contract = bundle.contract, backend = io.workerBackend;
  if (!backend) throw operationError('WORKER_UNAVAILABLE', 'independent Pi worker backend unavailable');
  const handles = new Map(), running = new Map(), proofs = new Map();
  const metrics = executionMetrics(state), startedAt = performance.now();
  const rememberProof = result => {
    const candidates = proofs.get(result.candidateDigest) ?? [];
    candidates.push(result); proofs.set(result.candidateDigest, candidates);
  };
  const coveredProof = (artifact, requiredIds) => {
    if (contract.mutableDependencies === true || !artifact.digest) return null;
    const candidates = proofs.get(artifact.digest);
    if (!candidates) return null;
    const environment = evaluatorEnvironment(io.cwd, io);
    if (!compatibleEnvironment(bundle.env, environment, false, bundle.assets)) return null;
    const proof = candidates.find(result => result.bundleDigest === bundle.digest &&
      result.environmentIdentity === digest(environment) &&
      requiredIds.every(id => result.outcomes.some(o => o.criterionId === id && o.status === 'PASS')));
    if (!proof) return null;
    metrics.proofReuseHits++;
    const wanted = new Set(requiredIds);
    return {...proof, outcomes:proof.outcomes.filter(o => wanted.has(o.criterionId)), allPass:true};
  };
  const persist = () => {
    ensureRunning(io.signal, root.deadlineAt, io.nowMs); host.persist();
    io.onProgress?.({phase:state.phase,stage:state.slices.map(s => `${s.id} ${s.status}`).join(', ')});
  };
  const evaluate = async (cwd, ids) => {
    const proof = coveredProof({digest:candidateIdentity(cwd, io)}, ids ?? contract.criteria.map(c => c.id));
    if (proof) return proof;
    const started = performance.now();
    let result;
    try { result = await host.evaluate(cwd, ids); }
    finally { recordExecutionEvaluation(state, result ?? {outcomes:[]}, performance.now() - started); }
    rememberProof(result);
    if (result.outcomes.some(o => o.status === 'ERROR')) throw operationError(result.outcomes.find(o => o.status === 'ERROR').errorCode ?? 'RUNNER_ERROR', 'candidate evaluation was inconclusive');
    return result;
  };
  const remaining = () => (root.attemptLimit ?? root.policy.maxTotalAttempts) - root.consumedAttempts;
  const charge = (record, digest) => {
    if (record.lastAttemptDigest === digest) return;
    if (remaining() <= 0) throw operationError('BUDGET_EXHAUSTED', 'shared implementation attempt budget exhausted');
    root.consumedAttempts++; record.lastAttemptDigest = digest; persist();
  };
  const start = async (record, spec, feedback) => {
    let handle = handles.get(record.id);
    if (!handle) {
      const started = performance.now();
      try { handle = await backend.start({ id: record.id, cwd: record.cwd, ...spec, signal: io.signal }); handles.set(record.id, handle); metrics.workerStarts++; }
      finally { metrics.workerMs += performance.now() - started; }
    }
    record.status = 'RUNNING'; state.phase = spec.kind === 'reconciliation' ? 'RECONCILING' : 'RUNNING'; persist();
    const work = Promise.resolve().then(async () => {
      const started = performance.now(); metrics.workerTurns++;
      if (spec.kind === 'reconciliation') metrics.reconciliationTurns++;
      try { return await backend.send(handle, feedback); }
      finally { metrics.workerMs += performance.now() - started; }
    }).then(() => ({ id: record.id }), error => ({ id: record.id, error }));
    running.set(record.id, work);
  };
  const reconcile = async (candidate, ids, context) => {
    const record = state.reconciliation ??= { id: `reconcile-${randomUUID()}`, cwd: path.join(state.directory, `reconcile-${randomUUID()}`), status: 'PENDING', candidate, ids, context };
    persist();
    if (!record.workspaceReady) {
      fs.rmSync(record.cwd, {recursive:true,force:true});
      await materialize(state.repo, record.candidate, record.cwd, io);
      record.workspaceReady = true; persist();
    }
    record.initialDigest ??= candidateIdentity(record.cwd, io);
    record.lastAttemptDigest ??= record.initialDigest;
    persist();
    const currentDigest = candidateIdentity(record.cwd, io);
    if (currentDigest !== record.lastAttemptDigest) charge(record, currentDigest);
    const proof = async () => {
      const result = await evaluate(record.cwd,record.ids), unresolved = unresolvedConflicts(record,io);
      return unresolved.length ? {...result,allPass:false,unresolvedConflicts:unresolved} : result;
    };
    let evidence = record.context.conflicts && currentDigest === record.initialDigest ? null : await proof();
    while (!evidence?.allPass) {
      if (remaining() <= 0) throw operationError('BUDGET_EXHAUSTED', 'shared reconciliation budget exhausted');
      const wanted = record.ids ? new Set(record.ids) : null;
      await start(record, { kind: 'reconciliation', contract: { goal: contract.goal, assumptions: contract.assumptions, exclusions: contract.exclusions },
        criteria: contract.criteria.filter(c => !wanted || wanted.has(c.id)).map(c => ({id:c.id,requirement:criterionRequirement(contract,c),type:c.type})),
        context: record.context }, { failures: evidence?.outcomes, conflicts: record.context.conflicts, unresolvedConflicts:evidence?.unresolvedConflicts });
      const settled = await running.get(record.id); running.delete(record.id);
      if (settled.error) throw settled.error;
      ensureRunning(io.signal, root.deadlineAt, io.nowMs);
      const digest = candidateIdentity(record.cwd, io);
      const changed = digest !== record.lastAttemptDigest;
      charge(record, digest);
      record.status = 'VERIFYING'; persist();
      evidence = await proof();
      if (!changed && !evidence.allPass) throw operationError('NO_PROGRESS', 'reconciler settled without changing its failing candidate');
    }
    const artifact = await captureCandidate(state.repo, record.cwd, [record.candidate.tip], io);
    if (artifact.digest !== evidence.candidateDigest) throw operationError('CANDIDATE_MUTATED', 'reconciled candidate changed after evaluation');
    if (handles.has(record.id)) { await backend.dispose(handles.get(record.id)); handles.delete(record.id); }
    state.reconciliation = null; persist();
    return { artifact, evidence };
  };
  try {
    // Interrupted sessions do not survive reload. Their candidate and charged digest do.
    for (const record of state.slices) if (['RUNNING', 'VERIFYING'].includes(record.status)) { record.status = 'PENDING'; record.recoverCandidate = true; }
    while (state.slices.some(s => s.status !== 'INTEGRATED')) {
      ensureRunning(io.signal, root.deadlineAt, io.nowMs);
      const integratedIds = new Set(state.slices.filter(s => s.status === 'INTEGRATED').flatMap(s => contract.execution.find(x => x.id === s.id).verify));
      const integratedHorizon = integrationHorizon(contract, integratedIds);
      // Readiness is established on this exact integration tree, never baseline or worker evidence.
      if (integratedIds.size) {
        state.evidence = coveredProof(state.integrated, integratedHorizon);
        if (!state.evidence) {
          const checkDir = path.join(state.directory, `proof-${randomUUID()}`);
          try { await materialize(state.repo, state.integrated, checkDir, io); state.evidence = await evaluate(checkDir, integratedHorizon); }
          finally { fs.rmSync(checkDir, { recursive: true, force: true }); }
        }
        if (!state.evidence.allPass) throw operationError('INTEGRATION_INVALID', 'accepted integration candidate no longer passes');
      }
      if (state.reconciliation) {
        const record = state.reconciliation;
        const repaired = await reconcile(record.candidate, record.ids, record.context);
        state.integrated = repaired.artifact; state.evidence = repaired.evidence;
        if (record.context.sliceId) state.slices.find(s => s.id === record.context.sliceId).status = 'INTEGRATED';
        persist(); continue;
      }
      const capacity = Math.min(root.policy.maxParallelWorkers ?? 2, remaining());
      for (const record of state.slices) {
        if (record.status !== 'PENDING') continue;
        const slice = contract.execution.find(s => s.id === record.id);
        if (!(slice.after ?? []).every(c => integratedIds.has(c) && state.evidence?.outcomes.some(o => o.criterionId === c && o.status === 'PASS'))) continue;
        if (!record.cwd) {
          if (running.size >= capacity) continue;
          record.base = state.integrated; record.cwd = path.join(state.directory, `worker-${record.id}-${randomUUID()}`);
          record.lastAttemptDigest = record.base.digest; persist();
        }
        if (!record.workspaceReady) {
          fs.rmSync(record.cwd, {recursive:true,force:true});
          await materialize(state.repo, record.base, record.cwd, io);
          record.workspaceReady = true; persist();
        }
        if (record.recoverCandidate) {
          charge(record, candidateIdentity(record.cwd, io));
          const proof = await evaluate(record.cwd, workerBehaviorHorizon(contract, slice.id));
          delete record.recoverCandidate;
          if (proof.allPass) {
            record.artifact = await captureCandidate(state.repo, record.cwd, [record.base.tip], io);
            if (record.artifact.digest !== proof.candidateDigest) throw operationError('CANDIDATE_MUTATED', 'recovered worker changed after verification');
            record.status = 'WORKER_VERIFIED'; persist(); continue;
          }
          record.failures = proof.outcomes;
        }
        if (running.size >= capacity) continue;
        await start(record, { kind: 'slice', ...prompt(contract, slice, record.failures) }, record.failures ? { failures: record.failures } : { objective: slice.objective });
      }
      let verified = state.slices.find(s => s.status === 'WORKER_VERIFIED');
      if (!verified) {
        if (!running.size) throw operationError(remaining() <= 0 ? 'BUDGET_EXHAUSTED' : 'NO_PATH', 'no runnable execution slice');
        const settled = await Promise.race(running.values()); running.delete(settled.id);
        if (settled.error) throw settled.error;
        const record = state.slices.find(s => s.id === settled.id), slice = contract.execution.find(s => s.id === record.id);
        const digest = candidateIdentity(record.cwd, io), unchanged = digest === record.lastAttemptDigest;
        charge(record, digest); record.status = 'VERIFYING'; state.phase = 'WORKER_VERIFICATION'; persist();
        const result = await evaluate(record.cwd, workerBehaviorHorizon(contract, slice.id));
        record.failures = result.outcomes;
        if (!result.allPass) {
          if (unchanged) throw operationError('NO_PROGRESS', `worker ${record.id} settled without changing its failing candidate`);
          record.status = 'PENDING'; persist(); continue;
        }
        record.artifact = await captureCandidate(state.repo, record.cwd, [record.base.tip], io);
        if (record.artifact.digest !== result.candidateDigest) throw operationError('CANDIDATE_MUTATED', 'worker changed after verification');
        record.status = 'WORKER_VERIFIED'; persist(); verified = record;
      }
      state.phase = 'INTEGRATING'; persist();
      if (handles.has(verified.id)) { await backend.dispose(handles.get(verified.id)); handles.delete(verified.id); }
      const merged = await merge(state.repo, verified.base, state.integrated, verified.artifact, io); metrics.mergeCount++;
      const slice = contract.execution.find(s => s.id === verified.id), ids = integrationHorizon(contract, [...integratedIds, ...workerBehaviorHorizon(contract, slice.id)]);
      const repaired = await reconcile(merged.artifact, ids, { sliceId: slice.id, objectives: contract.execution.filter(s => state.slices.some(r => r.id === s.id && r.status === 'INTEGRATED') || s.id === slice.id).map(s => s.objective),
        base: verified.base.tip, ours: state.integrated.tip, theirs: verified.artifact.tip, conflicts: merged.conflicts, conflictPaths:merged.conflictPaths });
      state.integrated = repaired.artifact; state.evidence = repaired.evidence; verified.status = 'INTEGRATED';
      state.phase = 'SCHEDULING'; persist();
    }
    if (state.reconciliation) {
      const record = state.reconciliation;
      const repaired = await reconcile(record.candidate, record.ids, record.context);
      state.integrated = repaired.artifact; state.evidence = repaired.evidence;
      if (record.context.canonicalArtifact) state.publicationBase = record.context.canonicalArtifact;
      persist();
    }
    // Prove the entire integration tree before attempting canonical publication.
    state.evidence = coveredProof(state.integrated, contract.criteria.map(c => c.id));
    if (!state.evidence) {
      const full = await reconcile(state.integrated, null, { fullRoot: true, objectives: contract.execution.map(s => s.objective) });
      state.integrated = full.artifact; state.evidence = full.evidence;
    }
    persist();
    state.phase = 'FINAL_RECONCILIATION'; persist();
    const publicationBase = state.publicationBase ?? state.base;
    const canonical = await captureCandidate(state.repo, io.cwd, [publicationBase.tip], io);
    if (canonical.digest !== publicationBase.digest) {
      const merged = await merge(state.repo, publicationBase, canonical, state.integrated, io); metrics.mergeCount++;
      const final = await reconcile(merged.artifact, null, { canonical: true, canonicalArtifact: canonical, base: publicationBase.tip, ours: canonical.tip, theirs: state.integrated.tip, conflicts: merged.conflicts, conflictPaths:merged.conflictPaths });
      state.integrated = final.artifact; state.evidence = final.evidence;
    }
    state.publicationBase = canonical; persist();
    // Concurrent canonical edits are another reconciliation input, never overwritten.
    if (candidateIdentity(io.cwd, io) !== canonical.digest) throw operationError('CANDIDATE_MUTATED', 'canonical workspace changed during final reconciliation; retry against its latest tree');
    const finalDir = path.join(state.directory, `final-${randomUUID()}`);
    try {
      await materialize(state.repo, state.integrated, finalDir, io);
      await host.apply(finalDir, canonical.digest);
    } finally { fs.rmSync(finalDir, { recursive: true, force: true }); }
    state.phase = 'CANONICAL_EVALUATION'; persist();
    return await host.complete();
  } finally {
    await Promise.allSettled([...handles.values()].map(h => backend.cancel(h)));
    await Promise.allSettled([...running.values()]);
    await Promise.allSettled([...handles.values()].map(h => backend.dispose(h)));
    metrics.totalMs += performance.now() - startedAt;
    host.persist();
  }
}
