import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FORMAT, DEFAULT_STORE_DIR, fail, digest, sha, fileSha, stable, confined, readJson, writeJson, inventory, treeDigest, copyTree, writeFiles, ensureStore, locked, resolveProgram } from './exitcode-files.mjs';
import { validateProject, validateContract, compare, MAX_HAPPY_PATH_CLAIMS } from './exitcode-spec.mjs';
import { invoke } from './exitcode-runner.mjs';

export const TOOL_NAMES = ['exitcode_project', 'exitcode_contract', 'exitcode_evaluate', 'exitcode_note'];
export const MODE_ENTRY = 'exitcode-scenarios';
export const PROTOCOL = `EXITCODE. Describe the current problem and 1 to ${MAX_HAPPY_PATH_CLAIMS} observable happy-path claims. Split only independently observable user outcomes, not implementation steps. Map every claim to at least one scenario using covers; reference only declared claim IDs. Before approval, investigate and build the smallest reusable project driver; do not change product files. Submit scenarios and observations, with no implementation plan or solution witness. Once the user approves, follow project instructions and choose your own implementation approach. Use focused checks while developing, delegate independent work only when worthwhile, and record useful discoveries or regressions in a short note. Evaluate a plausible candidate against the sealed scenarios. Only fresh PASS completes the task. Ask for missing external input in conversation; approval, infrastructure errors, and agent reports alone are not completion.`;

const timestamp = () => new Date().toISOString();
const errorResult = error => ({ ok: false, status: 'ERROR', code: error.code ?? 'IO_ERROR', message: error.message, ...(error.runId ? { runId: error.runId } : {}) });
const candidateDigest = (cwd, storeDir) => treeDigest(cwd, { candidate: true, storeDir });
const short = (text, max = 240) => typeof text === 'string' ? text.slice(0, max) : '';

function runtimeIdentity(manifest) {
  const file = resolveProgram(manifest.command.program);
  const result = { platform: process.platform, arch: process.arch, release: os.release(), program: fs.realpathSync(file), sha: fileSha(file) };
  if (manifest.isolation === 'bubblewrap') {
    if (!fs.existsSync('/usr/bin/bwrap')) fail('ISOLATION_UNAVAILABLE', 'bubblewrap is unavailable; no fallback is permitted');
    result.bubblewrap = fileSha('/usr/bin/bwrap');
  }
  return result;
}

export class ExitCode {
  constructor(cwd, { storeDir = DEFAULT_STORE_DIR, signal, expectedTask, runner = invoke, progress = () => {} } = {}) {
    this.cwd = fs.realpathSync(cwd); this.storeDir = storeDir; this.signal = signal; this.expectedTask = expectedTask; this.runner = runner; this.progress = progress;
  }
  store() { return ensureStore(this.cwd, this.storeDir, { create: false }); }
  taskFile(id) {
    if (typeof id !== 'string' || !/^T[A-Za-z0-9_-]{1,80}$/.test(id)) fail('INVALID_ID', 'Invalid task id');
    return confined(this.store().state, `tasks/${id}/task.json`);
  }
  load(id = this.store().index.active ?? this.store().index.latest) {
    if (!id) return null;
    const task = readJson(this.taskFile(id));
    if (task.format !== FORMAT || task.id !== id) fail('UNSUPPORTED_FORMAT', 'Unsupported task state');
    return task;
  }
  save(task) { writeJson(this.taskFile(task.id), task); }
  owned() {
    const id = this.store().index.active;
    if (!id || this.expectedTask !== undefined && this.expectedTask !== id) fail('TASK_MISMATCH', 'This session does not own the active task. Use /exitcode resume explicitly.');
    return this.load(id);
  }
  async operation(name, work) {
    try {
      return await locked(this.cwd, name, async store => {
        if (this.signal?.aborted) fail('CANCELLED', 'Operation cancelled');
        try { return await work(store); }
        catch (error) {
          const task = store.index.active ? this.load(store.index.active) : null;
          if (task && (this.expectedTask === undefined || task.id === this.expectedTask)) { task.lastIssue = { ...errorResult(error), at: timestamp(), operation: name }; this.save(task); }
          return errorResult(error);
        }
      }, this.storeDir);
    } catch (error) { return errorResult(error); }
  }
  unsealed(task) {
    if (!['DISCOVERY', 'READY'].includes(task.phase)) fail('SEALED', 'Acceptance and project definitions cannot change after approval. Start a new task to supersede them.');
    if (candidateDigest(this.cwd, this.storeDir) !== task.baselineDigest) {
      task.phase = 'DISCOVERY'; delete task.prepared; this.save(task);
      fail('CANDIDATE_CHANGED', 'Product changed before approval. Edits are preserved. Exit or explicitly resume to accept the current workspace and rebuild preparation.');
    }
  }
  project() {
    const root = confined(this.store().base, 'project');
    const manifest = readJson(confined(root, 'manifest.json')), files = {}, directory = confined(root, 'files');
    for (const entry of inventory(directory)) {
      if (entry.kind === 'link') fail('UNSAFE_PATH', 'Project definitions cannot contain symlinks');
      if (entry.kind === 'file') files[entry.path] = fs.readFileSync(confined(directory, entry.path), 'utf8');
    }
    return validateProject({ manifest, files });
  }
  async start(problem) {
    return this.operation('start', async store => {
      if (typeof problem !== 'string' || !problem.trim() || problem.length > 8192) fail('INVALID_SPEC', 'Provide a problem within 8192 characters');
      if (store.index.active) { const previous = this.load(store.index.active); previous.detachedAt = timestamp(); this.save(previous); }
      const task = { format: FORMAT, id: `T${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, problem: problem.trim(),
        phase: 'DISCOVERY', enteredAt: timestamp(), baselineDigest: candidateDigest(this.cwd, this.storeDir), runCount: 0 };
      this.save(task); store.index.active = task.id; store.index.latest = task.id; writeJson(store.file, store.index);
      return { ok: true, task: task.id, phase: task.phase, next: 'Inspect the project and configure or reuse its validation driver.' };
    });
  }
  async configure(project, { refresh = false } = {}) {
    return this.operation('project', async () => {
      const task = this.owned(); this.unsealed(task);
      const validated = validateProject(project), root = confined(this.store().base, 'project');
      const staged = confined(this.store().base, `project-${randomUUID()}`);
      writeJson(path.join(staged, 'manifest.json'), validated.manifest); writeFiles(path.join(staged, 'files'), validated.files);
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(staged, root);
      if (refresh) {
        const environment = confined(this.store().state, `environments/${digest(validated)}`);
        // Remove only the latest pointer. Sealed tasks retain their exact immutable environment bytes.
        const metadata = path.join(environment, 'identity.json');
        if (fs.existsSync(metadata)) fs.unlinkSync(metadata);
      }
      task.phase = 'DISCOVERY'; delete task.prepared; delete task.lastIssue; this.save(task);
      return { ok: true, projectDigest: digest(validated), next: 'Submit the smallest problem and happy-path scenarios with exitcode_contract.' };
    });
  }
  materializeProject(project, directory) {
    writeFiles(directory, project.files);
    // OS read-only mounts enforce this in bubblewrap; workspace drivers are trusted and checked afterwards.
    for (const entry of inventory(directory)) if (entry.kind === 'file') fs.chmodSync(path.join(directory, entry.path), 0o400);
  }
  verifyProjectCopy(project, directory) {
    const files = {};
    for (const entry of inventory(directory)) {
      if (entry.kind === 'link') fail('EVALUATOR_CHANGED', 'Driver created a project symlink');
      if (entry.kind === 'file') files[entry.path] = fs.readFileSync(path.join(directory, entry.path), 'utf8');
    }
    if (stable(files) !== stable(project.files)) fail('EVALUATOR_CHANGED', 'Validation driver changed during execution');
  }
  async call(project, request, timeoutSeconds) {
    this.progress({ operation: request.operation, scenario: request.scenario?.id });
    try {
      const result = await this.runner(project.manifest, { protocol: 1, ...request }, { signal: this.signal, timeoutSeconds });
      if (this.signal?.aborted) fail('CANCELLED', 'Late driver response after cancellation is not evidence');
      if (result.processResult) {
        fs.writeFileSync(path.join(request.runDirectory, `${request.operation}.stdout`), result.processResult.stdout);
        fs.writeFileSync(path.join(request.runDirectory, `${request.operation}.stderr`), result.processResult.stderr);
      }
      this.verifyProjectCopy(project, request.projectDirectory);
      return result;
    } catch (error) {
      if (error.processResult) for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(request.runDirectory, `${request.operation}.${stream}`), error.processResult[stream] ?? '');
      throw error;
    }
  }
  async environment(project, task, pinned) {
    const root = confined(this.store().state, `environments/${digest(project)}`), metadata = path.join(root, 'identity.json');
    const identity = runtimeIdentity(project.manifest);
    if (pinned || fs.existsSync(metadata)) {
      const known = pinned ?? readJson(metadata);
      if (!/^[a-f0-9]{64}$/.test(known.digest)) fail('DAMAGED_STATE', 'Invalid environment identity');
      const runtime = confined(root, `versions/${known.digest}`);
      if (!pinned && known.format !== FORMAT || stable(identity) !== stable(known.runtimeIdentity) || !fs.existsSync(runtime) || treeDigest(runtime) !== known.digest)
        fail('ENVIRONMENT_CHANGED', 'Prepared environment drifted. Refresh the project before sealing; sealed tasks require their original exact environment.');
      return { directory: runtime, digest: known.digest, runtimeIdentity: identity, warm: true };
    }
    const setupId = `E${randomUUID()}`, directory = confined(this.store().state, `tasks/${task.id}/environment-setup-${setupId}`);
    const runtime = confined(root, `preparing-${setupId}`);
    fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(directory, { recursive: true });
    const projectDirectory = path.join(directory, 'project'), candidateDirectory = path.join(directory, 'candidate');
    this.materializeProject(project, projectDirectory); copyTree(this.cwd, candidateDirectory, { candidate: true, storeDir: this.storeDir, signal: this.signal });
    const request = { operation: 'prepare', projectDirectory, candidateDirectory, runtimeDirectory: runtime, runDirectory: directory };
    let issue;
    try {
      const { report } = await this.call(project, request, project.manifest.timeoutSeconds);
      if (report.status !== 'OK') fail('ENVIRONMENT_UNAVAILABLE', report.reason ?? 'Driver could not prepare the environment');
    } catch (error) { issue = error; }
    finally {
      try {
        const cleanup = await this.runner(project.manifest, { protocol: 1, ...request, operation: 'dispose' }, { timeoutSeconds: Math.min(project.manifest.timeoutSeconds, 10) });
        if (cleanup.report.status !== 'OK') fail('CLEANUP_FAILED', cleanup.report.reason ?? 'Environment cleanup did not succeed');
        this.verifyProjectCopy(project, projectDirectory);
      } catch (error) { issue ??= Object.assign(error, { code: 'CLEANUP_FAILED' }); }
      fs.rmSync(candidateDirectory, { recursive: true, force: true }); fs.rmSync(projectDirectory, { recursive: true, force: true }); fs.rmSync(path.join(directory, 'home'), { recursive: true, force: true });
    }
    writeJson(path.join(directory, 'result.json'), { id: setupId, kind: 'environment', ...(issue ? errorResult(issue) : { ok: true, status: 'PASS' }), at: timestamp() });
    if (issue) { fs.rmSync(runtime, { recursive: true, force: true }); issue.runId = setupId; throw issue; }
    const fingerprint = treeDigest(runtime);
    const immutable = confined(root, `versions/${fingerprint}`);
    fs.mkdirSync(path.dirname(immutable), { recursive: true });
    if (fs.existsSync(immutable)) {
      if (treeDigest(immutable) !== fingerprint) fail('ENVIRONMENT_CHANGED', 'A stored immutable environment was changed');
      fs.rmSync(runtime, { recursive: true, force: true });
    } else fs.renameSync(runtime, immutable);
    writeJson(metadata, { format: FORMAT, digest: fingerprint, runtimeIdentity: identity, createdAt: timestamp() });
    return { directory: immutable, digest: fingerprint, runtimeIdentity: identity, warm: false };
  }
  artifacts(report, directory) {
    const artifacts = report.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > 32) fail('INVALID_REPORT', 'artifacts must contain at most 32 relative filenames');
    const result = [], seen = new Set();
    let bytes = 0;
    for (const name of artifacts) {
      const file = confined(directory, name);
      if (seen.has(name) || ['candidate', 'project', 'home', 'evidence'].includes(name.split('/')[0])
        || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail('INVALID_REPORT', `Invalid evidence artifact ${name}`);
      seen.add(name); bytes += fs.statSync(file).size;
      if (bytes > 16 * 1024 * 1024) fail('INVALID_REPORT', 'Artifacts exceed 16 MiB per trial');
      const copy = confined(directory, `evidence/${name}`);
      fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(file, copy);
      result.push({ path: `evidence/${name}`, bytes: fs.statSync(copy).size, sha: sha(fs.readFileSync(copy)) });
    }
    return result;
  }
  async trial(project, environment, task, scenario, runId, index, empty = false) {
    const directory = confined(this.store().state, `tasks/${task.id}/runs/${runId}/${scenario.id}-${empty ? 'wiring' : index}`);
    fs.mkdirSync(directory, { recursive: true });
    const projectDirectory = path.join(directory, 'project'), candidateDirectory = path.join(directory, 'candidate');
    this.materializeProject(project, projectDirectory);
    if (empty) fs.mkdirSync(candidateDirectory); else copyTree(this.cwd, candidateDirectory, { candidate: true, storeDir: this.storeDir, signal: this.signal });
    const request = { operation: 'run', projectDirectory, candidateDirectory, runtimeDirectory: environment.directory, runDirectory: directory,
      scenario: { id: scenario.id, instructions: scenario.instructions, input: scenario.input }, trial: index };
    let result, issue;
    try {
      const { report, processResult } = await this.call(project, request, scenario.timeoutSeconds);
      if (report.status === 'UNAVAILABLE') {
        if (!empty) fail('TARGET_UNAVAILABLE', report.reason);
        result = { scenario: scenario.id, trial: index, status: 'UNAVAILABLE', reason: report.reason };
      } else {
        if (report.status !== 'OK') fail('RUNNER_ERROR', report.reason);
        if (!report.observations || typeof report.observations !== 'object' || Array.isArray(report.observations)
          || Object.hasOwn(report.observations, '$run')) fail('INVALID_REPORT', 'Run requires an observations object; $run is reserved for external timing');
        const observations = { ...report.observations, $run: { elapsedMs: processResult.elapsedMs, startedAt: processResult.startedAt, finishedAt: processResult.finishedAt } };
        const assertions = compare(observations, scenario.assertions);
        result = { scenario: scenario.id, trial: index, status: assertions.every(a => a.status === 'PASS') ? 'PASS' : 'FAIL', observations, assertions,
          artifacts: this.artifacts(report, directory) };
        if (empty && result.status === 'PASS') fail('WIRING_PASSED_EMPTY', `Scenario ${scenario.id} passes without the product`);
      }
    } catch (error) { issue = error; }
    finally {
      // Dispose is a real driver operation, bounded independently even when the main operation was cancelled.
      try {
        const cleanup = await this.runner(project.manifest, { protocol: 1, ...request, operation: 'dispose' }, { timeoutSeconds: Math.min(project.manifest.timeoutSeconds, 10) });
        if (cleanup.report.status !== 'OK') fail('CLEANUP_FAILED', cleanup.report.reason ?? 'Driver cleanup did not succeed');
        this.verifyProjectCopy(project, projectDirectory);
      } catch (error) { issue ??= Object.assign(error, { code: 'CLEANUP_FAILED' }); }
      try { if (treeDigest(environment.directory) !== environment.digest) fail('ENVIRONMENT_CHANGED', 'Scenario or cleanup changed the frozen evaluator environment'); }
      catch (error) { issue ??= error; }
      if (this.signal?.aborted) issue ??= Object.assign(new Error('Cancellation during cleanup invalidates this run'), { code: 'CANCELLED' });
      const record = issue ? { scenario: scenario.id, trial: index, ...errorResult(issue) } : result;
      writeJson(path.join(directory, 'result.json'), record);
      fs.rmSync(candidateDirectory, { recursive: true, force: true }); fs.rmSync(projectDirectory, { recursive: true, force: true }); fs.rmSync(path.join(directory, 'home'), { recursive: true, force: true });
    }
    if (issue) throw issue;
    return result;
  }
  async run(contract, project, task, { prepare = false, environment: pinned } = {}) {
    const candidate = cwd => candidateDigest(cwd, this.storeDir);
    const runId = `R${randomUUID()}`, directory = confined(this.store().state, `tasks/${task.id}/runs/${runId}`), started = performance.now();
    const before = candidate(this.cwd), environment = await this.environment(project, task, pinned);
    if (pinned && (environment.digest !== pinned.digest || stable(environment.runtimeIdentity) !== stable(pinned.runtimeIdentity))) fail('ENVIRONMENT_CHANGED', 'Environment no longer matches the approved contract');
    const results = [];
    fs.mkdirSync(directory, { recursive: true });
    try {
      for (const scenario of contract.scenarios) {
        for (let index = 1; index <= scenario.trials; index++) {
          const result = await this.trial(project, environment, task, scenario, runId, index);
          results.push(result);
          if (prepare && result.status !== scenario.baseline) fail('BASELINE_MISMATCH', `${scenario.id}: expected baseline ${scenario.baseline}, observed ${result.status}; define reproducible conditions rather than supplying a solution`);
        }
        if (prepare) results.push({ ...await this.trial(project, environment, task, scenario, runId, 0, true), wiring: true });
      }
      if (this.signal?.aborted) fail('CANCELLED', 'Cancellation before recording evidence invalidates this run');
      if (candidate(this.cwd) !== before) fail('CANDIDATE_CHANGED', 'Canonical product changed during validation; results are stale and cannot complete the task');
      const result = { id: runId, kind: prepare ? 'preparation' : 'acceptance', status: prepare || results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL',
        candidateDigest: before, environment: { digest: environment.digest, runtimeIdentity: environment.runtimeIdentity },
        warmEnvironment: environment.warm, results, elapsedMs: performance.now() - started, at: timestamp() };
      writeJson(path.join(directory, 'run.json'), result);
      return result;
    } catch (error) {
      writeJson(path.join(directory, 'run.json'), { id: runId, ...errorResult(error), candidateDigest: before, results, at: timestamp() });
      error.runId = runId; throw error;
    }
  }
  async draft(contract) {
    return this.operation('contract', async () => {
      const task = this.owned(); this.unsealed(task);
      const validated = validateContract(contract), project = this.project();
      task.contract = validated; task.phase = 'DISCOVERY'; delete task.prepared; this.save(task);
      const run = await this.run(validated, project, task, { prepare: true });
      this.unsealed(task);
      if (digest(this.project()) !== digest(project)) fail('EVALUATOR_CHANGED', 'Project changed during preparation');
      task.prepared = { contract: validated, project, run, digest: digest({ contract: validated, project, candidateDigest: run.candidateDigest, environment: run.environment }) };
      task.phase = 'READY'; task.preparedAt = timestamp(); delete task.lastIssue; this.save(task);
      return { ok: true, task: task.id, phase: task.phase, review: review(task), preparation: run, next: 'User: /exitcode approve, or request a contract change.' };
    });
  }
  async approve() {
    return this.operation('approve', async () => {
      const task = this.owned(); this.unsealed(task);
      if (task.phase !== 'READY' || !task.prepared) fail('NOT_READY', 'Prepare and review a contract before approval');
      const prepared = task.prepared;
      validateContract(prepared.contract);
      const environment = await this.environment(prepared.project, task);
      if (this.signal?.aborted) fail('CANCELLED', 'Approval operation cancelled');
      if (digest(this.project()) !== digest(prepared.project) || candidateDigest(this.cwd, this.storeDir) !== prepared.run.candidateDigest
        || environment.digest !== prepared.run.environment.digest || stable(environment.runtimeIdentity) !== stable(prepared.run.environment.runtimeIdentity)) fail('STALE_PREPARATION', 'Candidate, project, or environment changed. Prepare and review again.');
      const bundle = { format: FORMAT, problem: task.problem, contract: prepared.contract, project: prepared.project, environment: prepared.run.environment };
      const file = confined(this.store().state, `tasks/${task.id}/sealed.json`);
      writeJson(file, bundle); fs.chmodSync(file, 0o400);
      task.sealedDigest = digest(bundle); task.phase = 'SEALED'; task.approvedAt = timestamp();
      delete task.prepared; delete task.lastIssue; this.save(task);
      return { ok: true, task: task.id, phase: task.phase, next: 'Follow project instructions and solve the problem. Implementation planning is yours to revise.' };
    });
  }
  sealed(task) {
    const bundle = readJson(confined(this.store().state, `tasks/${task.id}/sealed.json`));
    if (bundle.format !== FORMAT || digest(bundle) !== task.sealedDigest) fail('SEALED_CHANGED', 'Sealed acceptance changed; do not edit it. Start a superseding task if acceptance is wrong.');
    validateContract(bundle.contract);
    return bundle;
  }
  async evaluate() {
    return this.operation('evaluate', async store => {
      const task = this.owned();
      if (task.phase !== 'SEALED') fail('NOT_SEALED', 'Only approved contracts can evaluate an implementation');
      const bundle = this.sealed(task);
      task.runCount++; this.save(task);
      const run = await this.run(bundle.contract, bundle.project, task, { environment: bundle.environment });
      this.sealed(task);
      if (candidateDigest(this.cwd, this.storeDir) !== run.candidateDigest) fail('CANDIDATE_CHANGED', 'Product changed before completion was recorded; run acceptance again');
      task.lastRun = run; delete task.lastIssue;
      if (run.status === 'PASS') { task.phase = 'PASS'; task.completedAt = timestamp(); store.index.active = null; writeJson(store.file, store.index); }
      this.save(task);
      return { ok: true, task: task.id, phase: task.phase, status: run.status, run,
        next: run.status === 'PASS' ? 'Task complete on this exact candidate.' : 'Use the failing observations to choose the next change; keep acceptance fixed.' };
    });
  }
  inspect(kind, { runId, offset = 0 } = {}) {
    try {
      const task = this.owned();
      if (!Number.isInteger(offset) || offset < 0) fail('INVALID_SPEC', 'Inspection offset must be a nonnegative integer');
      let data;
      if (kind === 'contract') data = task.phase === 'SEALED' ? this.sealed(task).contract : task.contract;
      else if (kind === 'notes') {
        const file = confined(this.store().state, `tasks/${task.id}/journal.jsonl`);
        data = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      } else if (kind === 'run') {
        const id = runId ?? task.lastRun?.id ?? task.prepared?.run?.id ?? task.lastIssue?.runId;
        data = readJson(this.evidenceFile(task.id, id));
      } else fail('INVALID_SPEC', 'Inspect contract, run, or notes');
      const serialized = JSON.stringify(data ?? null, null, 2), end = Math.min(offset + 12000, serialized.length);
      return { ok: true, inspection: { kind, offset, totalCharacters: serialized.length, text: serialized.slice(offset, end), nextOffset: end < serialized.length ? end : null } };
    } catch (error) { return errorResult(error); }
  }
  evidenceFile(taskId, id) {
    if (typeof id !== 'string' || !/^[RE][a-f0-9-]{36}$/.test(id)) fail('INVALID_ID', 'Select a known run ID');
    return confined(this.store().state, id.startsWith('R') ? `tasks/${taskId}/runs/${id}/run.json` : `tasks/${taskId}/environment-setup-${id}/result.json`);
  }
  async note(note) {
    return this.operation('note', async () => {
      const task = this.owned();
      if (!note || Object.keys(note).some(key => !['hypothesis', 'change', 'result', 'disposition', 'next', 'evidence', 'waitingFor'].includes(key))
        || ['hypothesis', 'change', 'result', 'next'].some(key => typeof note[key] !== 'string' || note[key].length > 2048)
        || !['keep', 'revert', 'unresolved'].includes(note.disposition) || !Array.isArray(note.evidence) || note.evidence.length > 16
        || note.evidence.some(id => typeof id !== 'string' || !/^[RE][a-f0-9-]{36}$/.test(id) || !fs.existsSync(this.evidenceFile(task.id, id)))
        || note.waitingFor !== undefined && (typeof note.waitingFor !== 'string' || note.waitingFor.length > 2048)) fail('INVALID_NOTE', 'Provide a short work note, a disposition, and known run IDs; observations and agent interpretation remain distinct');
      const entry = { ...note, at: timestamp(), candidateDigest: candidateDigest(this.cwd, this.storeDir) };
      fs.appendFileSync(confined(this.store().state, `tasks/${task.id}/journal.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
      task.lastNote = entry; task.waitingFor = note.waitingFor || null; this.save(task);
      return { ok: true, note: entry, next: 'Continue from the saved hypothesis and evidence.' };
    });
  }
  async wake() {
    return this.operation('wake', async () => {
      const task = this.owned(); task.waitingFor = null; this.save(task); return { ok: true };
    });
  }
  async audit() {
    return this.operation('audit', async () => {
      const task = this.owned();
      if (task.phase === 'SEALED') this.sealed(task); else this.unsealed(task);
      return { ok: true, candidateDigest: candidateDigest(this.cwd, this.storeDir) };
    });
  }
  async detach() {
    return this.operation('exit', async store => {
      if (store.index.active && (this.expectedTask === undefined || this.expectedTask === store.index.active)) {
        const task = this.load(store.index.active); task.detachedAt = timestamp(); this.save(task); store.index.active = null; writeJson(store.file, store.index);
      }
      return { ok: true, next: 'Mode off; work is preserved and no success is claimed.' };
    });
  }
  async resume(id) {
    return this.operation('resume', async store => {
      const task = this.load(id ?? store.index.active ?? store.index.latest);
      if (!task || task.phase === 'PASS') fail('NOT_RESUMABLE', 'No unfinished task to resume');
      if (store.index.active && store.index.active !== task.id) { const previous = this.load(store.index.active); previous.detachedAt = timestamp(); this.save(previous); }
      if (task.phase === 'SEALED') this.sealed(task);
      else { task.baselineDigest = candidateDigest(this.cwd, this.storeDir); task.phase = 'DISCOVERY'; delete task.prepared; }
      delete task.detachedAt; task.waitingFor = null; task.resumedAt = timestamp(); this.save(task);
      store.index.active = task.id; store.index.latest = task.id; writeJson(store.file, store.index);
      return { ok: true, task: task.id, phase: task.phase, next: task.phase === 'SEALED' ? 'Continue on the current workspace; previous PASS observations are not completion.' : 'Inspect the current workspace and prepare fresh acceptance.' };
    });
  }
  freshPass(id) {
    const task = this.load(id);
    return task?.phase === 'PASS' && this.sealed(task) && task.lastRun?.candidateDigest === candidateDigest(this.cwd, this.storeDir);
  }
  status(id, detail = false) {
    try {
      const store = this.store(), task = this.load(id);
      if (!task) return { ok: true, active: false, storeDir: this.storeDir, storePath: store.base, next: '/exitcode <problem>' };
      return { ok: true, task: task.id, active: store.index.active === task.id, storeDir: this.storeDir, storePath: store.base, phase: task.phase, problem: task.problem, runCount: task.runCount,
        lastIssue: task.lastIssue, lastRun: detail ? task.lastRun : task.lastRun && { id: task.lastRun.id, status: task.lastRun.status },
        lastNote: task.lastNote, waitingFor: task.waitingFor, ...(detail ? { contract: task.contract, prepared: task.prepared, sealedDigest: task.sealedDigest } : {}) };
    } catch (error) { return errorResult(error); }
  }
}

export function review(task) {
  const { contract, project, run } = task.prepared;
  return [
    `Problem: ${task.problem}`, `Contract problem: ${contract.problem}`, 'Happy path claims:',
    ...contract.happyPath.map(value => `  ${value.id}: ${value.claim}`),
    ...contract.constraints.map(value => `Constraint: ${value}`),
    `Project: ${project.manifest.name}; ${project.manifest.isolation} isolation; runner ${project.manifest.command.program} ${project.manifest.command.args.join(' ')}`,
    `Environment variables made available by name: ${project.manifest.environment.join(', ') || 'none'}`,
    ...contract.scenarios.flatMap(s => [`Scenario ${s.id}: ${s.description}`, `Covers: ${s.covers.join(', ') || 'none'}`, `Instructions: ${s.instructions}`, `Input: ${stable(s.input)}`,
      `Baseline ${s.baseline}; ${s.trials} fresh trial(s); all must pass after implementation; watchdog ${s.timeoutSeconds}s`,
      ...s.assertions.map(a => `  ${a.path} ${a.op}${a.op === 'present' ? '' : ` ${stable(a.value)}`}`)]),
    `Preparation ${run.id}: reproduced declared baselines and rejected an empty target; ${run.warmEnvironment ? 'reused' : 'built'} environment`,
    'Coverage is declared. Review whether each scenario observes the claims it covers.',
    'No passing implementation witness was built. These finite checks do not prove complete intent coverage.',
    `Bundle: ${task.prepared.digest}`, 'Approve the acceptance conditions with /exitcode approve. Implementation approach remains adaptive.',
  ].join('\n');
}

export function promptStatus(status) {
  return [status.ok ? `Task ${status.task ?? 'none'}: ${status.phase ?? 'OFF'}` : `${status.code}: ${short(status.message)}`,
    status.storePath && `Storage: ${status.storePath}`,
    status.problem && `Problem: ${short(status.problem, 600)}`, status.lastRun && `Last acceptance: ${status.lastRun.status} (${status.lastRun.id})`,
    status.lastIssue && `Issue: ${status.lastIssue.code}: ${short(status.lastIssue.message)}`,
    status.lastNote && `Working hypothesis: ${short(status.lastNote.hypothesis)}\nNext experiment: ${short(status.lastNote.next)}`,
    status.waitingFor && `Await external input: ${short(status.waitingFor)}`,
    status.phase === 'READY' && 'Await user approval. End the turn.', status.next].filter(Boolean).join('\n').slice(0, 2048);
}
