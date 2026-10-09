import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const FORMAT = 'exitcode-scenarios-1';
export const MAX_TREE_BYTES = 512 * 1024 * 1024;
export const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const sha = value => createHash('sha256').update(value).digest('hex');
export const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => sha(stable(value));

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
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH', `Symlink in path: ${name}`);
  }
  return target;
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
export function inventory(root, { candidate = false, signal, maxBytes = MAX_TREE_BYTES } = {}) {
  const entries = [];
  let bytes = 0;
  const walk = (directory, prefix = '') => {
    if (signal?.aborted) fail('CANCELLED', 'Operation cancelled');
    for (const name of fs.readdirSync(directory).sort()) {
      if (candidate && !prefix && ['.git', '.exitcode'].includes(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name, full = path.join(directory, name), stat = fs.lstatSync(full);
      if (stat.isDirectory()) { entries.push({ path: rel, kind: 'directory', mode: stat.mode & 0o777 }); walk(full, rel); }
      else if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(full), target = path.relative(root, resolved);
        if (target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)
          || candidate && ['.git', '.exitcode'].includes(target.split(path.sep)[0])) fail('UNSAFE_PATH', `Link escapes candidate: ${rel}`);
        entries.push({ path: rel, kind: 'link', target: path.relative(path.dirname(full), resolved).split(path.sep).join('/') });
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) fail('TREE_TOO_LARGE', `Snapshot exceeds ${maxBytes} bytes; use a focused project workspace`);
        entries.push({ path: rel, kind: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha: sha(fs.readFileSync(full)) });
      } else fail('UNSAFE_PATH', `Unsupported filesystem object: ${rel}`);
    }
  };
  walk(root);
  return entries;
}

export const treeDigest = (root, options) => digest(inventory(root, options));

export function copyTree(source, destination, options) {
  const before = inventory(source, options);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of before) {
    const target = path.join(destination, entry.path);
    if (entry.kind === 'directory') fs.mkdirSync(target, { recursive: true });
    else if (entry.kind === 'link') fs.symlinkSync(entry.target, target);
    else { fs.copyFileSync(path.join(source, entry.path), target); fs.chmodSync(target, entry.mode); }
  }
  for (const entry of [...before].reverse()) if (entry.kind === 'directory') fs.chmodSync(path.join(destination, entry.path), entry.mode);
  if (digest(inventory(source, options)) !== digest(before) || treeDigest(destination, { signal: options?.signal }) !== digest(before))
    fail('CANDIDATE_CHANGED', 'Files changed while capturing the candidate');
  return digest(before);
}

export function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = confined(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
}

export function ensureStore(cwd) {
  const base = path.join(cwd, '.exitcode');
  if (fs.existsSync(path.join(base, 'index.json'))) fail('UNSUPPORTED_FORMAT', 'Legacy .exitcode store detected. Move it aside explicitly before using this replacement. No migration is provided.');
  const state = path.join(base, 'state');
  // Supervisor paths must not alias a product or another workspace.
  for (const directory of [base, state]) if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) fail('UNSAFE_PATH', 'Supervisor directory is a symlink');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, 'index.json');
  if (!fs.existsSync(file)) writeJson(file, { format: FORMAT, active: null, latest: null });
  const index = readJson(file);
  if (index.format !== FORMAT) fail('UNSUPPORTED_FORMAT', 'Unsupported ExitCode store; no compatibility reader or migration is provided');
  return { base, state, file, index };
}

export async function locked(cwd, operation, work) {
  const store = ensureStore(cwd), file = path.join(store.state, 'operation.lock'), token = randomUUID();
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
