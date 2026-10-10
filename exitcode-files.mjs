import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const FORMAT = 'exitcode-scenarios-1';
export const DEFAULT_STORE_DIR = '.agents/.exitcode';
// Evaluator trees stay bounded; product snapshots honor only explicit budgets.
export const MAX_TREE_BYTES = 512 * 1024 * 1024;
const defaultMaxBytes = candidate => candidate ? Infinity : MAX_TREE_BYTES;
const HASH_CHUNK_BYTES = 1024 * 1024;
export const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, ...details }); };
export const sha = value => createHash('sha256').update(value).digest('hex');
export const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => sha(stable(value));

function hashFile(file, buffer, signal) {
  if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
  const descriptor = fs.openSync(file, 'r'), hash = createHash('sha256');
  try {
    while (true) {
      if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) return hash.digest('hex');
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
}

export const fileSha = (file, { signal } = {}) => hashFile(file, Buffer.allocUnsafe(HASH_CHUNK_BYTES), signal);

export function resolveProgram(program) {
  const requested = program === 'node' ? process.execPath : program;
  const candidates = path.isAbsolute(requested) ? [requested]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, requested));
  const file = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
  if (!file) fail('RUNNER_ERROR', `Runner program is unavailable: ${program}`);
  return fs.realpathSync(file);
}

export function relative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.posix.isAbsolute(name)
    || name.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(name))
    fail('UNSAFE_PATH', `Expected a confined relative path: ${name}`);
  return name;
}

export function confined(root, name) {
  const target = path.join(root, relative(name));
  let current = root;
  for (const part of ['', ...name.split('/')]) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fail('UNSAFE_PATH', `Symlink in path: ${name}`);
  }
  return target;
}

// Store paths are dedicated, project-relative directories. No expansion or aliases.
export function resolveStoreDir(cwd, storeDir = DEFAULT_STORE_DIR) {
  relative(storeDir);
  if (storeDir.startsWith('~') || storeDir.split('/').includes('.git') || /[\x00-\x1f\x7f]/.test(storeDir) || !storeDir.trim())
    fail('UNSAFE_PATH', 'storeDir must be a project-relative directory outside .git, without home expansion or control characters');
  let current = cwd;
  for (const part of storeDir.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('UNSAFE_PATH', `Store path is not a regular directory: ${current}`);
  }
  return current;
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('DAMAGED_STATE', `Cannot read ${path.basename(file)}: ${error.message}`); }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

// No Git index, ignore rules, or live-file aliases. Modes and link targets participate.
export function inventory(root, { candidate = false, storeDir = DEFAULT_STORE_DIR, signal, maxBytes = defaultMaxBytes(candidate), treeKind = candidate ? 'candidate' : 'evaluator tree' } = {}) {
  if (candidate) resolveStoreDir(root, storeDir);
  const excluded = candidate ? ['.git', storeDir] : [];
  const excludes = name => excluded.some(directory => name === directory || name.startsWith(directory + '/'));
  const entries = [];
  let bytes = 0;
  const walk = (directory, prefix = '') => {
    if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (excludes(rel)) continue;
      const full = path.join(directory, name), stat = fs.lstatSync(full);
      if (stat.isDirectory()) { entries.push({ path: rel, kind: 'directory', mode: stat.mode & 0o777 }); walk(full, rel); }
      else if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(full), target = path.relative(root, resolved).split(path.sep).join('/');
        if (target === '..' || target.startsWith('../') || path.isAbsolute(target) || excludes(target)) fail('UNSAFE_PATH', `Link escapes candidate: ${rel}`);
        entries.push({ path: rel, kind: 'link', target: path.relative(path.dirname(full), resolved).split(path.sep).join('/') });
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) fail('TREE_TOO_LARGE', `${treeKind} at ${root} exceeds ${maxBytes} bytes (${bytes} observed at ${JSON.stringify(rel)})`,
          { diagnostics: { tree: { kind: treeKind, directory: root, path: rel, observedBytes: bytes, maxBytes } } });
        entries.push({ path: rel, kind: 'file', mode: stat.mode & 0o777, bytes: stat.size });
      } else fail('UNSAFE_PATH', `Unsupported filesystem object: ${rel}`);
    }
  };
  walk(root);
  // Reject explicit budgets before reading content; reuse one buffer for the tree.
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  for (const entry of entries) if (entry.kind === 'file') entry.sha = hashFile(path.join(root, entry.path), buffer, signal);
  return entries;
}

export const treeDigest = (root, options) => digest(inventory(root, options));

export function inventoryDifferences(expected, actual) {
  const left = new Map(expected.map(entry => [entry.path, entry])), right = new Map(actual.map(entry => [entry.path, entry]));
  const differences = [];
  let totalDifferences = 0;
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const before = left.get(name), after = right.get(name);
    const fields = ['kind', 'mode', 'bytes', 'sha', 'target'].filter(field => before?.[field] !== after?.[field]);
    if (!fields.length) continue;
    totalDifferences++;
    if (differences.length < 8) differences.push({ path: name, fields, expected: before ?? null, actual: after ?? null });
  }
  return { totalDifferences, differences };
}

export const describeDifferences = ({ differences, totalDifferences }) => differences.map(entry => `${JSON.stringify(entry.path)} [${entry.fields.join(', ')}]`).join('; ')
  + (totalDifferences > differences.length ? `; ${totalDifferences - differences.length} more paths` : '');

function captureMismatch(expected, actual, comparison, source, destination) {
  const changes = inventoryDifferences(expected, actual);
  fail('CANDIDATE_CHANGED', `Files differ while capturing the candidate (${comparison}): ${describeDifferences(changes)}`,
    { diagnostics: { capture: { comparison, source, destination, ...changes } } });
}

// Scratch must not inherit a product workspace or any parent repository's Git metadata.
export function allocateScratch(cwd) {
  const temporary = fs.realpathSync(os.tmpdir()), workspace = fs.realpathSync(cwd), rel = path.relative(workspace, temporary);
  if (!rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
    fail('UNSAFE_PATH', 'Execution scratch must be outside the product workspace; set TMPDIR to an external OS scratch directory');
  for (let directory = temporary; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git')))
      fail('UNSAFE_PATH', 'Execution scratch must be outside Git ancestry; set TMPDIR to an external OS scratch directory');
    if (path.dirname(directory) === directory) break;
  }
  return fs.mkdtempSync(path.join(temporary, 'exitcode-'));
}

export function copyTree(source, destination, { candidate = false, storeDir = DEFAULT_STORE_DIR, signal, maxBytes = defaultMaxBytes(candidate), treeKind } = {}) {
  const options = { candidate, storeDir, signal, maxBytes, treeKind }, before = inventory(source, options), fingerprint = digest(before);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of before) {
    if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
    const target = path.join(destination, entry.path);
    if (entry.kind === 'directory') fs.mkdirSync(target, { recursive: true });
    else if (entry.kind === 'link') fs.symlinkSync(entry.target, target);
    else { fs.copyFileSync(path.join(source, entry.path), target, fs.constants.COPYFILE_FICLONE); fs.chmodSync(target, entry.mode); }
  }
  for (const entry of [...before].reverse()) if (entry.kind === 'directory') fs.chmodSync(path.join(destination, entry.path), entry.mode);
  const after = inventory(source, options);
  if (digest(after) !== fingerprint) captureMismatch(before, after, 'source-before/source-after', source, destination);
  const captured = inventory(destination, { signal, maxBytes, treeKind });
  if (digest(captured) !== fingerprint) captureMismatch(before, captured, 'source/copy', source, destination);
  return fingerprint;
}

export function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = confined(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
}

export function ensureStore(cwd, storeDir = DEFAULT_STORE_DIR, { create = true } = {}) {
  const base = resolveStoreDir(cwd, storeDir);
  if (fs.existsSync(path.join(base, 'index.json'))) fail('UNSUPPORTED_FORMAT', `Legacy ExitCode store at ${base}. Move it aside explicitly. No migration is provided.`);
  if (fs.existsSync(base) && fs.readdirSync(base).some(name => !['project', 'state'].includes(name) && !/^project-[a-f0-9-]{36}$/.test(name)))
    fail('UNSAFE_PATH', `Use a dedicated store directory, not a product directory: ${base}`);
  const state = confined(base, 'state');
  if (fs.existsSync(state) && !fs.lstatSync(state).isDirectory()) fail('UNSAFE_PATH', 'Supervisor state path is not a directory');
  const file = confined(base, 'state/index.json');
  const empty = { format: FORMAT, active: null, latest: null };
  if (create) {
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) writeJson(file, empty);
  }
  const index = fs.existsSync(file) ? readJson(file) : empty;
  if (index.format !== FORMAT) fail('UNSUPPORTED_FORMAT', 'Unsupported ExitCode store; no compatibility reader or migration is provided');
  return { base, state, file, index };
}

export async function locked(cwd, operation, work, storeDir = DEFAULT_STORE_DIR) {
  const store = ensureStore(cwd, storeDir), file = path.join(store.state, 'operation.lock'), token = randomUUID();
  if (fs.existsSync(file)) {
    const owner = readJson(file);
    try { process.kill(owner.pid, 0); fail('OPERATION_BUSY', `ExitCode is running ${owner.operation}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; fs.unlinkSync(file); }
  }
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, operation }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('OPERATION_BUSY', 'Another ExitCode operation owns this workspace'); throw error; }
  try { return await work(store); }
  finally { if (fs.existsSync(file) && readJson(file).token === token) fs.unlinkSync(file); }
}
