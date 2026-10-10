import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fail, resolveProgram } from './exitcode-files.mjs';

const OUTPUT_LIMIT = 1024 * 1024;
const REPORT_STATUSES = ['OK', 'UNAVAILABLE', 'ERROR'];
const REPORT_KEYS = ['protocol', 'status', 'observations', 'artifacts', 'reason'];
const stopped = signal => Object.assign(new Error('Operation cancelled'), { code: 'CANCELLED', cause: signal?.reason });

function bubblewrap(manifest, request, env) {
  if (process.platform !== 'linux') fail('ISOLATION_UNAVAILABLE', 'bubblewrap requires Linux; choose an explicit project-managed workspace runner instead');
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr'];
  for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
    const full = `/${name}`;
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) args.push('--symlink', fs.readlinkSync(full), full);
    else args.push('--ro-bind', full, full);
  }
  try { fs.accessSync('/usr/bin/bwrap', fs.constants.X_OK); } catch { fail('ISOLATION_UNAVAILABLE', 'bubblewrap is unavailable; no host fallback is permitted'); }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/runtime', '--ro-bind', resolveProgram('node'), '/runtime/node');
  const mapped = { ...request };
  for (const [key, destination] of [['projectDirectory', '/project'], ['runtimeDirectory', '/environment'], ['candidateDirectory', '/candidate'], ['runDirectory', '/run']]) {
    mapped[key] = destination;
    args.push(key === 'projectDirectory' || key === 'runtimeDirectory' && request.operation !== 'prepare' ? '--ro-bind' : '--bind', request[key], destination);
  }
  // The writable /run mount must not expose a second writable alias to a read-only driver or runtime.
  for (const key of ['projectDirectory', ...(request.operation === 'prepare' ? [] : ['runtimeDirectory'])]) {
    const rel = path.relative(request.runDirectory, request[key]);
    if (rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) args.push('--ro-bind', request[key], `/run/${rel}`);
  }
  args.push('--clearenv', '--setenv', 'PATH', '/runtime:/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8');
  for (const key of manifest.environment) if (env[key] !== undefined) args.push('--setenv', key, env[key]);
  args.push('--chdir', '/project', '--', manifest.command.program === 'node' ? '/runtime/node' : manifest.command.program, ...manifest.command.args);
  return { program: '/usr/bin/bwrap', args, request: mapped };
}

// A workspace runner is an explicit trusted host process, never a silent sandbox fallback.
// A driver can wrap a container, remote environment, API, browser, or SDK itself.
export async function invoke(manifest, request, { signal, timeoutSeconds = manifest.timeoutSeconds } = {}) {
  if (signal?.aborted) throw stopped(signal);
  const home = path.join(request.runDirectory, 'home'), work = path.join(request.runDirectory, 'work');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const env = { PATH: [path.dirname(resolveProgram('node')), '/usr/bin', '/bin'].join(path.delimiter), HOME: home, TMPDIR: work, LANG: 'C.UTF-8' };
  if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.PATH = process.env.PATH; }
  for (const key of manifest.environment) if (process.env[key] !== undefined) env[key] = process.env[key];
  let program = resolveProgram(manifest.command.program);
  let args = manifest.command.args, input = request;
  if (manifest.isolation === 'bubblewrap') ({ program, args, request: input } = bubblewrap(manifest, request, env));
  const startedAt = new Date().toISOString(), started = performance.now();
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: request.projectDirectory, env: manifest.isolation === 'bubblewrap' ? {} : env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0, error, spawnError;
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (killError) { if (killError.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const cancel = () => { error ??= stopped(signal); kill(); };
    const timer = setTimeout(() => { error ??= Object.assign(new Error(`Driver exceeded ${timeoutSeconds} seconds`), { code: 'DRIVER_TIMEOUT' }); kill(); }, timeoutSeconds * 1000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { error ??= Object.assign(new Error('Driver output exceeded 1 MiB'), { code: 'OUTPUT_LIMIT' }); kill(); }
      else chunks[stream].push(chunk);
    });
    child.on('error', value => { spawnError = value; });
    child.stdin.on('error', () => {}); // Early exit still reaches close and produces a diagnostic.
    child.stdin.end(JSON.stringify(input) + '\n');
    child.on('close', (exit, termSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); kill();
      const result = { exit, termSignal, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString(),
        startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started };
      if (error) reject(Object.assign(error, { processResult: result }));
      else if (spawnError) reject(Object.assign(new Error(spawnError.message), { code: manifest.isolation === 'bubblewrap' ? 'ISOLATION_UNAVAILABLE' : 'RUNNER_ERROR', processResult: result }));
      else resolve(result);
    });
  });
  if (signal?.aborted) throw Object.assign(stopped(signal), { processResult });
  if (processResult.exit !== 0) throw Object.assign(new Error(`Driver exited ${processResult.exit}: ${processResult.stderr.slice(-2000)}`),
    { code: manifest.isolation === 'bubblewrap' && /^bwrap:/m.test(processResult.stderr) ? 'ISOLATION_UNAVAILABLE' : 'RUNNER_ERROR', processResult });
  let report;
  try { report = JSON.parse(processResult.stdout); }
  catch { throw Object.assign(new Error('Driver stdout must contain one JSON response, without prose or fences'), { code: 'INVALID_REPORT', processResult }); }
  const object = report !== null && typeof report === 'object' && !Array.isArray(report);
  const unknown = object ? Object.keys(report).filter(key => !REPORT_KEYS.includes(key)) : [];
  if (!object || report.protocol !== 1 || !REPORT_STATUSES.includes(report.status) || unknown.length)
    throw Object.assign(new Error(`Invalid driver protocol 1 response: require an object with protocol: 1 and status: ${REPORT_STATUSES.join(', ')}.${unknown.length ? ` Unknown keys: ${unknown.slice(0, 8).map(key => JSON.stringify(key).slice(0, 128)).join(', ')}${unknown.length > 8 ? `; ${unknown.length - 8} more` : ''}.` : ''}`),
      { code: 'INVALID_REPORT', processResult });
  if (report.status !== 'OK' && (typeof report.reason !== 'string' || !report.reason.trim()))
    throw Object.assign(new Error('UNAVAILABLE and ERROR require a reason'), { code: 'INVALID_REPORT', processResult });
  return { report, processResult };
}
