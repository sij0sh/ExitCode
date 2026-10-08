/** Bounded evaluator recipes, discovery, and the executable isolation boundary. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureRunning, operationError, operationSignal, stopReason } from './exitcode-operation.mjs';

export const RECIPE_KINDS = Object.freeze(['file_exists', 'file_contains', 'file_not_contains', 'json_value', 'existing_test', 'test_suite', 'build_succeeds', 'typecheck_succeeds', 'command_exit', 'custom_command']);
export const MUTATION_KINDS = Object.freeze(['write_file', 'delete_file', 'replace_text', 'copy_fixture', 'set_json_value']);
/** Recipes the supervisor can evaluate, witness, and challenge without executing candidate code. */
export const BUILTIN_RECIPES = Object.freeze(['file_exists', 'file_contains', 'file_not_contains', 'json_value']);
const RESERVED = new Set(['.exitcode', '.git', '.pi']);
const OMIT = new Set(['.exitcode', '.git', 'node_modules']);
const CANDIDATE_OMIT = new Set(['.exitcode', '.git']);
const OUTPUT_CAP = 64 * 1024;
export const stable = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(stable).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
export const digest = x => createHash('sha256').update(typeof x === 'string' ? x : stable(x)).digest('hex');

export function diagnostic(code, stage, criterionId, evidence, recommendedRepair, repairability = 'agent') {
  return { code, stage, criterionId: criterionId ?? null, evidence: String(evidence), repairability, recommendedRepair };
}

export function safePath(cwd, rel, {allowFinalSymlink = false, allowConfig = false} = {}) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(p => p === '..' || RESERVED.has(p) && !(allowConfig && p === '.pi'))) throw new Error(`unsafe candidate path: ${rel}`);
  const root = fs.realpathSync(cwd);
  let part = root;
  const names = rel.split('/');
  for (const [i, name] of names.entries()) {
    part = path.join(part, name);
    try { if (fs.lstatSync(part).isSymbolicLink() && !(allowFinalSymlink && i === names.length - 1)) throw new Error(`symlink path forbidden: ${rel}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (part === root || !part.startsWith(root + path.sep)) throw new Error(`unsafe candidate path: ${rel}`);
  return part;
}

export function inventory(cwd, { dependencies = false, signal, deadlineAt, nowMs=Date.now } = {}) {
  const options={signal,deadlineAt,nowMs};ensureRunning(signal,deadlineAt,nowMs);
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      ensureRunning(signal,deadlineAt,nowMs);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((dependencies ? CANDIDATE_OMIT : OMIT).has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ rel, full, size: fs.statSync(full).size, mode: fs.statSync(full).mode & 0o777, sha: fileDigest(full,options) });
      else if (entry.isSymbolicLink()) files.push({ rel, full, link: fs.readlinkSync(full) });
      else throw operationError('UNSUPPORTED_CANDIDATE_FILE', `unsupported candidate file: ${rel}`);
    }
  };
  walk(cwd);
  return files;
}

// Full content identity, including executable modes and symlink targets. No sampling.
export function fileDigest(file, {signal,deadlineAt,nowMs=Date.now}={}) {
  ensureRunning(signal,deadlineAt,nowMs);
  const hash = createHash('sha256'); const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(1024 * 1024); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) {ensureRunning(signal,deadlineAt,nowMs);hash.update(buf.subarray(0,n));} }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function candidateIdentity(cwd,options) { return digest(inventory(cwd, {...options,dependencies:true}).map(({rel,sha,size,mode,link}) => ({rel,sha,size,mode,link}))); }

const capabilityCache = new Map();
export function scanCapabilities(cwd) {
  const files = inventory(cwd); const key = digest(files.map(({rel,sha,link}) => ({rel,sha,link})));
  if (capabilityCache.has(key)) return structuredClone(capabilityCache.get(key));
  let pkg = {};
  const packageFile = safePath(cwd, 'package.json');
  if (fs.existsSync(packageFile)) pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const availableScripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([,v]) => typeof v === 'string'));
  const existingTests = files.filter(f => !f.link && /(?:\.test|\.spec)\.[cm]?[jt]s$/.test(f.rel)).map(f => f.rel);
  const selectors = {};
  let nodeTest = Object.values(availableScripts).some(s => /\bnode\s+--test\b/.test(s));
  for (const file of existingTests) {
    // Literal test names only. Never import the test file. Dynamic names require custom_command.
    const text = fs.readFileSync(safePath(cwd, file), 'utf8');
    if (/['"]node:test['"]/.test(text)) nodeTest = true;
    selectors[file] = [...text.matchAll(/\b(?:test|it|describe)(?:\.(?:only|skip|todo))?\s*\(\s*(['"])([^\n]*?)\1/g)].map(x => x[2]);
  }
  const manifest = {
    version: 1, language: files.some(f => /\.tsx?$/.test(f.rel)) ? 'TypeScript' : 'JavaScript',
    packageManager: files.some(f => f.rel === 'pnpm-lock.yaml') ? 'pnpm' : files.some(f => f.rel === 'yarn.lock') ? 'yarn' : 'npm',
    testRunner: nodeTest ? 'node:test' : null, testCommand: availableScripts.test ? 'npm test' : null,
    buildCommand: availableScripts.build ? 'npm run build' : null,
    typecheckCommand: availableScripts.typecheck ? 'npm run typecheck' : null,
    lintCommand: availableScripts.lint ? 'npm run lint' : null,
    existingTests, selectors, sourceRoots: ['src', 'lib', 'app'].filter(p => files.some(f => f.rel.startsWith(p+'/'))),
    testRoots: ['test', 'tests', '__tests__'].filter(p => files.some(f => f.rel.startsWith(p+'/'))), availableScripts,
  };
  manifest.digest = digest({ key, manifest });
  capabilityCache.set(key, manifest);
  if (capabilityCache.size > 16) capabilityCache.delete(capabilityCache.keys().next().value);
  return structuredClone(manifest);
}

function pointerParts(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('JSON pointer must start with /');
  const keys = pointer.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('unsafe JSON pointer');
  return keys;
}
function jsonGet(obj, pointer) {
  for (const k of pointerParts(pointer)) { if (obj === null || typeof obj !== 'object' || !Object.hasOwn(obj, k)) return undefined; obj = obj[k]; }
  return obj;
}
export function validateMutation(m) {
  if (!m || !MUTATION_KINDS.includes(m.kind)) throw new Error('unknown mutation kind');
  if (typeof m.path !== 'string' || !m.path) throw new Error('mutation path required');
  if (m.kind === 'write_file' && typeof m.content !== 'string') throw new Error('write_file content required');
  if (m.kind === 'replace_text' && (typeof m.from !== 'string' || !m.from || typeof m.to !== 'string')) throw new Error('replace_text needs nonempty from and string to');
  if (m.kind === 'copy_fixture' && typeof m.from !== 'string') throw new Error('copy_fixture from required');
  if (m.kind === 'set_json_value') { pointerParts(m.pointer); if (!Object.hasOwn(m,'value')) throw new Error('JSON value required'); }
}
export async function applyMutations(cwd, mutations) {
  if (!Array.isArray(mutations) || mutations.length > 32) throw new Error('mutations must be an array of at most 32 operations');
  for (const m of mutations) {
    validateMutation(m); const full = safePath(cwd, m.path);
    if (m.kind === 'write_file') { if (Buffer.byteLength(m.content) > 8 * 1024 * 1024) throw new Error('mutation content too large'); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full,m.content); }
    if (m.kind === 'delete_file') fs.rmSync(full, { force: true, recursive: true });
    if (m.kind === 'replace_text') { const text = fs.readFileSync(full,'utf8'); if (!text.includes(m.from) || m.from === m.to) throw new Error('replacement makes no change'); fs.writeFileSync(full,text.split(m.from).join(m.to)); }
    if (m.kind === 'copy_fixture') { const source = safePath(cwd,m.from); if (!fs.statSync(source).isFile()) throw new Error('copy source must be a regular file'); fs.mkdirSync(path.dirname(full),{recursive:true}); fs.copyFileSync(source,full,fs.constants.COPYFILE_FICLONE); }
    if (m.kind === 'set_json_value') {
      const obj = JSON.parse(fs.readFileSync(full,'utf8')), keys = pointerParts(m.pointer); let at = obj;
      for (const k of keys.slice(0,-1)) { if (!at || typeof at !== 'object' || !Object.hasOwn(at,k)) throw new Error('JSON parent missing'); at=at[k]; }
      if (!at || typeof at !== 'object') throw new Error('JSON parent not an object');
      at[keys.at(-1)] = m.value; fs.writeFileSync(full, JSON.stringify(obj,null,2)+'\n');
    }
  }
}

export function compileRecipe(r, capabilities = {}) {
  if (!r || !RECIPE_KINDS.includes(r.kind)) throw new Error(`unknown recipe: ${r?.kind}`);
  if (r.kind.startsWith('file_') || r.kind === 'json_value') {
    if (typeof r.path !== 'string' || !r.path) throw new Error('recipe path required');
    if (['file_contains','file_not_contains'].includes(r.kind) && (typeof r.value !== 'string' || !r.value)) throw new Error('nonempty content value required');
    if (r.kind === 'json_value') { pointerParts(r.pointer); if (!Object.hasOwn(r,'value')) throw new Error('JSON value required'); }
    return { operation: 'builtin', recipe: structuredClone(r) };
  }
  if (r.kind === 'existing_test') {
    if (capabilities.testRunner !== 'node:test') throw new Error('RUNNER_NOT_FOUND: node:test not discovered');
    if (!capabilities.existingTests?.includes(r.path)) throw new Error('CHECK_TARGET_MISSING: test file not discovered');
    if (typeof r.selector !== 'string' || !capabilities.selectors?.[r.path]?.includes(r.selector)) throw new Error('TEST_SELECTOR_NOT_FOUND: literal test selector not discovered');
    return { operation:'command', executable:'node', args:['--test','--test-reporter=tap',`--test-name-pattern=^${escapeRegex(r.selector)}$`,r.path], selectedTest:true };
  }
  if (['test_suite','build_succeeds','typecheck_succeeds'].includes(r.kind)) {
    const script = {test_suite:'test',build_succeeds:'build',typecheck_succeeds:'typecheck'}[r.kind];
    if (capabilities.packageManager !== 'npm') throw new Error('RUNNER_NOT_FOUND: initial script recipes require npm');
    if (!capabilities.availableScripts?.[script]) throw new Error(`CHECK_TARGET_MISSING: npm script ${script} missing`);
    return {operation:'command',executable:'npm',args:['run',script],script};
  }
  if (r.kind === 'command_exit') {
    if (typeof r.command !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(r.command) || !Array.isArray(r.args ?? []) || !(r.args ?? []).every(x => typeof x === 'string')) throw new Error('command_exit requires executable basename and string args');
    return {operation:'command',executable:r.command,args:r.args ?? []};
  }
  if (typeof r.command !== 'string' || !r.command.trim()) throw new Error('custom command required');
  return {operation:'shell',command:r.command,custom:true};
}
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";

export async function runRecipe(recipe, {cwd, timeoutMs = 900000, capabilities, exec = sandboxCommand, signal, deadlineAt, nowMs=Date.now, readOnlyPaths = [], onExecution} = {}) {
  try {
    ensureRunning(signal);
    const cap = capabilities ?? scanCapabilities(cwd), compiled = compileRecipe(recipe,cap);
    if (compiled.operation === 'builtin') {
      const full = safePath(cwd,recipe.path);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return {exit:1,stdout:'target missing',stderr:'',timedOut:false};
      let pass = true;
      if (recipe.kind !== 'file_exists') {
        const text = fs.readFileSync(full,'utf8');
        if (recipe.kind === 'file_contains') pass = text.includes(recipe.value);
        if (recipe.kind === 'file_not_contains') pass = !text.includes(recipe.value);
        if (recipe.kind === 'json_value') pass = stable(jsonGet(JSON.parse(text),recipe.pointer)) === stable(recipe.value);
      }
      return {exit:pass?0:1,stdout:pass?'match':'mismatch',stderr:'',timedOut:false};
    }
    // Recheck selected targets in the actual fixture, not only in the cached manifest.
    if(compiled.operation==='command' && !fs.existsSync('/usr/bin/'+compiled.executable) && !fs.existsSync('/bin/'+compiled.executable) && !['node','npm'].includes(compiled.executable))return {exit:null,error:`runtime unavailable: ${compiled.executable}`,errorCode:'RUNNER_NOT_FOUND'};
    if (compiled.selectedTest) {
      const actual = scanCapabilities(cwd);
      if (!actual.existingTests.includes(recipe.path) || !actual.selectors[recipe.path]?.includes(recipe.selector)) return {exit:1,stdout:'selected test missing',stderr:'',timedOut:false};
      safePath(cwd,recipe.path);
    }
    if (compiled.script) {
      const actual = scanCapabilities(cwd);
      if (!actual.availableScripts[compiled.script]) return {exit:1,stdout:'script missing',stderr:'',timedOut:false};
    }
    const command = compiled.command ?? [compiled.executable,...compiled.args].map(quote).join(' ');
    onExecution?.();
    const run = await exec(command,{cwd,timeoutMs,writable:true,signal,deadlineAt,nowMs,readOnlyPaths});
    if (!run.error && !run.timedOut && (run.exit===126 || run.exit===127))return {...run,error:'executable runtime unavailable',errorCode:'RUNNER_NOT_FOUND'};
    if (compiled.selectedTest && run.exit === 0 && !/^# pass [1-9]\d*$/m.test(run.stdout)) return {...run,exit:1,stdout:run.stdout+'\nNo selected test executed'};
    return run;
  } catch (e) {
    if ((['ENOENT','ENOTDIR'].includes(e.code) || e instanceof SyntaxError) && (recipe?.kind?.startsWith('file_') || recipe?.kind==='json_value')) return {exit:1,stdout:'invalid or missing target',stderr:e.message,timedOut:false};
    return {exit:null,stdout:'',stderr:'',error:e.message,errorCode:e.code ?? e.message.match(/^(RUNNER_NOT_FOUND|CHECK_TARGET_MISSING|TEST_SELECTOR_NOT_FOUND):/)?.[1] ?? 'RUNNER_ERROR',timedOut:false};
  }
}

// Do not inherit credentials, NODE_OPTIONS, shell startup files, sockets, or host /proc.
// Only system runtime trees and the caller's independent fixture are mounted.
// A supervisor verification can itself run inside this sandbox. Reuse its read-only npm mount.
const npmRuntime = () => fs.existsSync('/runtime/npm/bin/npm-cli.js') ? '/runtime/npm' : path.join(path.dirname(fs.realpathSync(process.execPath)), '../lib/node_modules/npm');

export function sandboxArgs(cwd, {writable = false, readOnlyPaths = []} = {}) {
  const args = ['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/usr','/usr'];
  for (const name of ['lib','lib64','bin','sbin']) {
    const full = '/'+name;
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) args.push('--symlink',fs.readlinkSync(full),full);
    else args.push('--ro-bind',full,full);
  }
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/runtime','--ro-bind',fs.realpathSync(process.execPath),'/runtime/node');
  const npm = npmRuntime();
  if (fs.existsSync(npm)) args.push('--ro-bind',fs.realpathSync(npm),'/runtime/npm');
  args.push(writable?'--bind':'--ro-bind',fs.realpathSync(cwd),'/workspace','--chdir','/workspace','--clearenv','--setenv','PATH','/runtime:/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8');
  for (const rel of readOnlyPaths) {
    const source = safePath(cwd, rel);
    if (fs.existsSync(source)) args.push('--ro-bind', source, '/workspace/' + rel);
  }
  return args;
}

export async function sandboxCommand(command, {cwd,timeoutMs = 900000,bwrapPath = '/usr/bin/bwrap',writable = false,signal,deadlineAt,nowMs=Date.now,readOnlyPaths = []} = {}) {
  const started = Date.now();
  let operation, args;
  try {
    ensureRunning(signal);
    operation = operationSignal(signal, {timeoutMs,deadlineAt,nowMs});
    fs.accessSync(bwrapPath,fs.constants.X_OK);
    args = sandboxArgs(cwd,{writable,readOnlyPaths});
    ensureRunning(operation.signal);
  } catch(e) {
    operation?.dispose();
    return {exit:null,stdout:'',stderr:'',timedOut:false,error:e.message,errorCode:e.code ?? 'ISOLATION_UNAVAILABLE',durationMs:Date.now()-started};
  }
  const wrapper = 'mkdir -p /tmp/bin; printf \'#!/bin/sh\nexec /runtime/node /runtime/npm/bin/npm-cli.js "$@"\n\' > /tmp/bin/npm; chmod 700 /tmp/bin/npm; export PATH=/tmp/bin:$PATH; ';
  return new Promise(resolve => {
    let child;
    try{child = spawn(bwrapPath,[...args,'/bin/sh','-c',wrapper+command],{stdio:['ignore','pipe','pipe'],env:{},detached:true});}catch(e){operation.dispose();resolve({exit:null,stdout:'',stderr:'',timedOut:false,error:e.message,errorCode:'ISOLATION_UNAVAILABLE'});return;}
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false,done=false,stopped,spawnError;
    const append=(buf,x)=>{const result=Buffer.concat([buf,x]);if(result.length>OUTPUT_CAP){truncated=true;return result.subarray(result.length-OUTPUT_CAP);}return result;};
    child.stdout.on('data',x=>stdout=append(stdout,x));child.stderr.on('data',x=>stderr=append(stderr,x));
    const finish=r=>{if(done)return;done=true;operation.signal.removeEventListener('abort',abort);operation.dispose();resolve({...r,stdout:stdout.toString(),stderr:stderr.toString(),durationMs:Date.now()-started,truncated});};
    const abort=()=>{
      stopped=stopReason(operation.signal);
      try { if(child.pid)process.kill(-child.pid,'SIGKILL'); }
      catch(e){if(e.code!=='ESRCH')child.kill('SIGKILL');}
      // Resolve only after close. Bubblewrap's PID namespace kills remaining descendants.
    };
    operation.signal.addEventListener('abort',abort,{once:true});
    if(operation.signal.aborted)abort();
    child.on('error',e=>{spawnError=e;});
    child.on('close',(exit,termSignal)=>finish(spawnError?{exit:null,timedOut:false,error:`isolation unavailable: ${spawnError.message}`,errorCode:'ISOLATION_UNAVAILABLE'}:stopped
      ? {exit:null,timedOut:stopped.code==='CHECK_TIMEOUT',error:stopped.message,errorCode:stopped.code}
      : {exit,timedOut:false,...(termSignal||/^bwrap:/m.test(stderr.toString())?{error:`isolation failed: ${stderr.toString()||termSignal}`,errorCode:'ISOLATION_UNAVAILABLE'}:{})}));
  });
}

export function evaluatorEnvironment(cwd,options) {
  const runtime = [process.execPath,'/usr/bin/bwrap','/bin/sh'].map(p=>{try{return {path:p,digest:fileDigest(fs.realpathSync(p),options)};}catch(e){if(['CANCELLED','DEADLINE_EXCEEDED','CHECK_TIMEOUT'].includes(e.code))throw e;return {path:p,error:e.code};}});
  const npm = npmRuntime();
  return {platform:os.platform(),release:os.release(),arch:os.arch(),node:process.version,runtime,
    npm:fs.existsSync(npm)?candidateIdentity(npm,options):null,
    dependencies:fs.existsSync(path.join(cwd,'node_modules'))?digest(inventory(path.join(cwd,'node_modules'),{...options,dependencies:true}).map(({rel,sha,mode,link})=>({rel,sha,mode,link}))):null,
    runnerVersion:1};
}

/** Deterministic preflight only. Intent coverage is derived independently by semantic review. */
export function auditCriteria(criteria = []) {
  const diagnostics=[],seen=new Set();
  for(const c of criteria){
    const norm=c.requirement?.trim().replace(/\s+/g,' ').toLowerCase();
    if(seen.has(norm))diagnostics.push(diagnostic('DUPLICATE_CRITERION','intent',c.id,c.requirement,'Merge criteria that restate the same outcome'));
    seen.add(norm);
  }
  return diagnostics;
}

/**
 * A minimal positive witness: authored, supervisor-generated for built-in
 * recipes, or else the unmodified candidate (null control).
 */
export function positiveWitness(criterion) {
  if (criterion.controls?.accept) return {source:'author',control:criterion.controls.accept};
  const r=criterion.check.recipe;
  if (!BUILTIN_RECIPES.includes(r?.kind)) return {source:'baseline',control:null};
  const content = r.kind==='file_contains' ? r.value : r.kind==='json_value' ? JSON.stringify(pointerParts(r.pointer).reduceRight((v,k)=>({[k]:v}),r.value)) : '';
  return {source:'generated',control:{mutations:[{kind:'write_file',path:r.path,content}]}};
}

// Pre-seal controls describe evidence; they must not encode a second implementation.
const OVERBUILT = Object.freeze({controlBytes:64*1024, files:16, setupBytes:4*1024, repeatedBytes:8*1024});
const OVERBUILT_REPAIR = 'A control is a minimal witness that the check can discriminate, not a reference implementation. Prefer an existing test, omit controls, narrow the criterion, or shrink the witness';
function overbuilt(draft) {
  const diagnostics=[],seen=new Map();
  for(const c of draft.criteria){
    for(const control of [c.controls?.accept,...(c.controls?.reject??[])].filter(Boolean)){
      const bytes=Buffer.byteLength(stable(control)),files=new Set((control.mutations??[]).map(m=>m.path)).size,setup=Buffer.byteLength(control.setup??'');
      if(bytes>OVERBUILT.controlBytes||files>OVERBUILT.files||setup>OVERBUILT.setupBytes)
        diagnostics.push(diagnostic('EVALUATOR_OVERBUILT','lint',c.id,`control is ${bytes} bytes across ${files} files with ${setup} bytes of setup`,OVERBUILT_REPAIR));
      if(bytes>OVERBUILT.repeatedBytes){const key=digest(control);seen.set(key,[...(seen.get(key)??[]),c.id]);}
    }
  }
  for(const ids of seen.values())if(new Set(ids).size>1)
    diagnostics.push(diagnostic('EVALUATOR_OVERBUILT','lint',ids[1],`the same substantial control is repeated in ${[...new Set(ids)].join(', ')}`,OVERBUILT_REPAIR));
  return diagnostics;
}

export function lintEvaluators(draft, cwd, capabilities) {
  const diagnostics=overbuilt(draft);
  for(const c of draft.criteria){
    const recipe=c.check.recipe;
    try {
      if(recipe){compileRecipe(recipe,capabilities);if(recipe.path)safePath(cwd,recipe.path);}
      for(const control of [c.controls?.accept,...(c.controls?.reject??[])].filter(Boolean))for(const mutation of control.mutations??[]){validateMutation(mutation);safePath(cwd,mutation.path);if(mutation.kind==='copy_fixture')safePath(cwd,mutation.from);}
    }catch(e){const code=e.message.split(':')[0];diagnostics.push(diagnostic(['RUNNER_NOT_FOUND','CHECK_TARGET_MISSING','TEST_SELECTOR_NOT_FOUND'].includes(code)?code:e.message.startsWith('command_exit requires')?'INVALID_SPEC':'UNSAFE_COMMAND','lint',c.id,e.message,'Use a discovered runner, literal selector, and confined fixture paths'));}
    const command=recipe?.command??c.check.command??'';
    if(/https?:\/\/|\b(?:curl|wget|ssh|nc|sudo)\b/.test(command))diagnostics.push(diagnostic('EXTERNAL_DEPENDENCY','lint',c.id,'External or privileged command','Use local deterministic evidence'));
    if(recipe?.path&&BUILTIN_RECIPES.includes(recipe.kind)&&c.controls?.accept?.mutations){
      const present=fs.existsSync(safePath(cwd,recipe.path));
      const supplied=c.controls.accept.mutations.some(m=>m.path===recipe.path&&['write_file','copy_fixture'].includes(m.kind));
      if(!present&&!supplied)diagnostics.push(diagnostic('CHECK_TARGET_MISSING','lint',c.id,recipe.path,'Supply the target in the positive witness, or omit controls'));
    }
  }
  return diagnostics;
}

export function normalizeEvaluator(draft) {
  const normalized=structuredClone(draft),repairs=[];
  for(const c of normalized.criteria){
    if(c.check.recipe?.kind==='existing_test'&&c.check.recipe.runner==='discovered'){delete c.check.recipe.runner;repairs.push({criterionId:c.id,repair:'Use discovered node:test runner'});}
    if(typeof c.check.timeoutSeconds==='string'&&/^\d+(\.\d+)?$/.test(c.check.timeoutSeconds)){c.check.timeoutSeconds=Number(c.check.timeoutSeconds);repairs.push({criterionId:c.id,repair:'Normalize numeric timeout'});}
  }
  return {draft:normalized,repairs};
}


/** Isolated temporary copies stay on the candidate filesystem, outside Git ancestry. */
export function fixtureDirectory(cwd, prefix = 'exitcode-fixture-') {
  let parent = path.dirname(path.resolve(cwd));
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) parent = path.dirname(dir);
    if (dir === path.dirname(dir)) break;
  }
  try { return fs.mkdtempSync(path.join(parent, prefix)); }
  catch(e) {
    if (!['EACCES','EPERM','EROFS'].includes(e.code)) throw e;
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$|(?:^|\/)(?:jest|vitest|pytest|playwright|tsconfig)[^/]*\.(?:[cm]?[jt]s|json)$|(?:^|\/)(?:pytest.ini|tox.ini|scripts\/verify)$/;
// Development dependencies and runner settings remain immutable. Only these
// product dependency declarations may change under explicit plan approval.
const PRODUCT_DEPENDENCY_FIELDS = new Set(['dependencies', 'optionalDependencies', 'peerDependencies']);
function acceptancePackage(content) {
  const value = JSON.parse(content);
  return stable(Object.fromEntries(Object.entries(value).filter(([key]) => !PRODUCT_DEPENDENCY_FIELDS.has(key))));
}

/** Discover installed evaluator dependencies without importing package code. */
function evaluatorPackages(cwd, pkg, declaredPaths) {
  const packages = new Set(), bins = new Set(), absent = new Set();
  const resolve = (from, name) => {
    if (!/^(?:@[^/.]+\/)?[^/.][^/]*$/.test(name)) throw operationError('EVALUATOR_DEPENDENCY_INVALID', `invalid dependency name: ${name}`);
    for (let dir = from; ; dir = path.posix.dirname(dir)) {
      const rel = (dir && dir !== '.' ? dir + '/' : '') + 'node_modules/' + name;
      if (fs.existsSync(safePath(cwd, rel + '/package.json'))) return rel;
      absent.add(rel);
      if (!dir || dir === '.') return null;
    }
  };
  const visit = (from, name, optional = false) => {
    const rel = resolve(from, name);
    if (!rel) {
      if (optional) return;
      throw operationError('EVALUATOR_DEPENDENCY_MISSING', `installed evaluator dependency missing: ${name}`);
    }
    if (packages.has(rel)) return;
    packages.add(rel);
    const dependency = JSON.parse(fs.readFileSync(safePath(cwd, rel + '/package.json'), 'utf8'));
    const names = typeof dependency.bin === 'string' ? [name.split('/').at(-1)] : Object.keys(dependency.bin ?? {});
    for (const bin of names) if (fs.existsSync(path.join(cwd, 'node_modules/.bin', bin))) bins.add('node_modules/.bin/' + bin);
    for (const child of Object.keys(dependency.dependencies ?? {})) visit(rel, child, Object.hasOwn(dependency.optionalDependencies ?? {}, child));
    for (const child of Object.keys(dependency.optionalDependencies ?? {})) visit(rel, child, true);
    for (const child of Object.keys(dependency.peerDependencies ?? {})) visit(rel, child, true);
  };
  for (const name of Object.keys(pkg.devDependencies ?? {})) visit('', name);
  for(const rel of declaredPaths){const match=rel.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);if(match)visit('',match[1]);}
  // Installed executable packages are evaluator runtimes even when listed as
  // production dependencies. Product-only library dependencies remain mutable.
  const binDirectory=path.join(cwd,'node_modules/.bin');
  if(!fs.existsSync(binDirectory))absent.add('node_modules/.bin');
  if(fs.existsSync(binDirectory))for(const name of fs.readdirSync(binDirectory)){
    const rel='node_modules/.bin/'+name,full=safePath(cwd,rel,{allowFinalSymlink:true});
    const stat=fs.lstatSync(full);
    if(!stat.isSymbolicLink())throw operationError('EVALUATOR_DEPENDENCY_INVALID',`executable dependency must have a confined package target: ${rel}`);
    const link=fs.readlinkSync(full),target=path.relative(cwd,path.resolve(path.dirname(full),link));
    if(path.isAbsolute(link) || !/^node_modules\/(?:@[^/]+\/)?[^/]+\//.test(target))throw operationError('EVALUATOR_DEPENDENCY_INVALID',`executable dependency escapes its package: ${rel}`);
    safePath(cwd,target);
    const parts=target.split('/'),packageName=parts[1].startsWith('@')?parts.slice(1,3).join('/'):parts[1];
    visit('',packageName);bins.add(rel);
  }
  return {packages: [...packages].sort(), bins: [...bins].sort(), absentPaths:[...absent].sort()};
}

/** Freeze acceptance assets, not implementation files merely executed or imported by checks. */
export function captureEvaluatorAssets(cwd, draft, directory) {
  const files = inventory(cwd, {dependencies:true});
  const conventionalPaths=files.filter(f=>!f.rel.split('/').includes('node_modules') && TEST_PATH.test(f.rel)).map(f=>f.rel).sort();
  const paths = new Set(conventionalPaths);
  const readOnly = new Set(), directories=new Set();
  for(const f of files.filter(f=>!f.rel.split('/').includes('node_modules'))) {
    const parts=f.rel.split('/');
    const i=parts.findIndex(p=>/^(?:tests?|__tests__|fixtures)$/.test(p));
    if(i>=0){const rel=parts.slice(0,i+1).join('/');if(fs.lstatSync(safePath(cwd,rel)).isDirectory()){readOnly.add(rel);directories.add(rel);}}
  }
  const declare = rel => {
    const full = safePath(cwd, rel);
    rel = path.relative(fs.realpathSync(cwd), full);
    if (!fs.existsSync(full)) throw operationError('EVALUATOR_ASSET_MISSING', `declared acceptance asset missing: ${rel}`);
    readOnly.add(rel);if(fs.lstatSync(full).isDirectory())directories.add(rel);
    for (const f of files) if (f.rel === rel || f.rel.startsWith(rel + '/')) paths.add(f.rel);
  };
  for (const rel of draft.criteria.flatMap(c => c.check.assets ?? [])) declare(rel);
  for (const c of draft.criteria) if (c.check.recipe?.kind === 'existing_test') declare(c.check.recipe.path);
  let dependencyBoundary = null;
  if (files.some(f => f.rel === 'package.json')) {
    paths.add('package.json');
    if (draft.mutableDependencies === true) {
      const pkg = JSON.parse(fs.readFileSync(safePath(cwd, 'package.json'), 'utf8'));
      const frozen = evaluatorPackages(cwd, pkg, [...readOnly]);
      for (const rel of frozen.packages) declare(rel);
      for (const rel of frozen.bins) paths.add(rel);
      if (fs.existsSync(path.join(cwd,'node_modules/.bin'))){readOnly.add('node_modules/.bin');directories.add('node_modules/.bin');}
      dependencyBoundary = {version:1, evaluatorPackages:frozen.packages, absentPaths:frozen.absentPaths};
    }
  } else if (draft.mutableDependencies === true) {
    throw operationError('INVALID_SPEC', 'mutableDependencies requires a package.json product dependency boundary');
  }
  if(draft.mutableDependencies!==true && fs.existsSync(path.join(cwd,'node_modules')))readOnly.add('node_modules');
  const entries = [];
  fs.mkdirSync(directory, {recursive:true});
  try {
    for(const rel of directories)fs.mkdirSync(path.join(directory,rel),{recursive:true});
    for (const rel of [...paths].sort()) {
      const source = safePath(cwd, rel, {allowFinalSymlink:true}), stat = fs.lstatSync(source);
      const full = path.join(directory, rel);
      fs.mkdirSync(path.dirname(full), {recursive:true});
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(source);
        if(path.isAbsolute(link))throw operationError('EVALUATOR_ASSET_INVALID',`acceptance symlink must stay relative to the fixture: ${rel}`);
        const target = path.relative(cwd, path.resolve(path.dirname(source), link));
        safePath(cwd, target, {allowFinalSymlink:true});
        if (!paths.has(target)) throw operationError('EVALUATOR_ASSET_INVALID', `acceptance symlink must target another frozen asset: ${rel}`);
        fs.symlinkSync(link, full);
        entries.push({path:rel, link});
        continue;
      }
      if (!stat.isFile()) throw operationError('EVALUATOR_ASSET_INVALID', `acceptance asset is not a regular file: ${rel}`);
      const kind = rel === 'package.json' && draft.mutableDependencies === true ? 'package_configuration' : 'file';
      fs.copyFileSync(source, full, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(full, stat.mode & 0o777);
      entries.push({path:rel, mode:stat.mode & 0o777, size:stat.size, kind,
        sha:kind === 'package_configuration' ? digest(acceptancePackage(fs.readFileSync(full, 'utf8'))) : fileDigest(full)});
      if (![...readOnly].some(p => rel === p || rel.startsWith(p + '/'))) readOnly.add(rel);
    }
    const manifest = {version:1, files:entries, conventionalPaths, directories:[...directories].sort(), readOnlyPaths:[...readOnly].sort(), dependencyBoundary};
    return {...manifest, digest:digest(manifest)};
  } catch (e) { fs.rmSync(directory, {recursive:true, force:true}); throw e; }
}

export function verifyEvaluatorAssets(cwd, directory, assets) {
  const {digest:expected, ...manifest} = assets ?? {};
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.readOnlyPaths) || !Array.isArray(manifest.directories) || !Array.isArray(manifest.conventionalPaths) || expected !== digest(manifest))
    throw operationError('EVALUATOR_ASSET_INVALID', 'acceptance asset manifest mismatch');
  for(const rel of assets.dependencyBoundary?.absentPaths??[])if(fs.existsSync(safePath(cwd,rel)))throw operationError('EVALUATOR_DRIFT',`evaluator dependency resolution changed: ${rel}`);
  const liveFiles=inventory(cwd,{dependencies:true});
  const conventionalPaths=liveFiles.filter(f=>!f.rel.split('/').includes('node_modules') && TEST_PATH.test(f.rel)).map(f=>f.rel).sort();
  if(stable(conventionalPaths)!==stable(assets.conventionalPaths))throw operationError('EVALUATOR_DRIFT','acceptance test or runner inventory changed');
  for(const rel of assets.directories){
    const live=liveFiles.filter(f=>f.rel.startsWith(rel+'/')).map(f=>f.rel).sort();
    const expected=assets.files.filter(f=>f.path.startsWith(rel+'/')).map(f=>f.path).sort();
    if(stable(live)!==stable(expected))throw operationError('EVALUATOR_DRIFT',`acceptance inventory changed: ${rel}`);
  }
  for (const root of [directory, cwd]) for (const f of assets.files) {
    const full = safePath(root, f.path, {allowFinalSymlink:true});
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (e) { if (e.code !== 'ENOENT') throw e; throw operationError('EVALUATOR_DRIFT', `acceptance asset missing: ${f.path}`); }
    if (f.link !== undefined) {
      if (!stat.isSymbolicLink() || fs.readlinkSync(full) !== f.link) throw operationError('EVALUATOR_DRIFT', `acceptance symlink changed: ${f.path}`);
      continue;
    }
    if (!stat.isFile()) throw operationError('EVALUATOR_DRIFT', `acceptance asset is not a regular file: ${f.path}`);
    const sha = f.kind === 'package_configuration' ? digest(acceptancePackage(fs.readFileSync(full, 'utf8'))) : fileDigest(full);
    if (sha !== f.sha || (stat.mode & 0o777) !== f.mode) throw operationError('EVALUATOR_DRIFT', `acceptance asset changed: ${f.path}`);
  }
}

/** Overlay the validated evaluator after product-only fixture setup. */
export function installEvaluatorAssets(fixture, directory, assets) {
  for (const f of assets.files) {
    const full = safePath(fixture, f.path, {allowFinalSymlink:f.kind !== 'package_configuration'});
    fs.mkdirSync(path.dirname(full), {recursive:true});
    if (f.link !== undefined) {
      fs.rmSync(full, {force:true, recursive:true});
      fs.symlinkSync(f.link, full);
    } else if (f.kind === 'package_configuration') {
      const frozen = JSON.parse(fs.readFileSync(path.join(directory, f.path), 'utf8'));
      const product = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
      for (const key of PRODUCT_DEPENDENCY_FIELDS) { delete frozen[key]; if (Object.hasOwn(product, key)) frozen[key] = product[key]; }
      // Replace the file so restoration never writes through a candidate hard link.
      fs.rmSync(full, {force:true, recursive:true});
      fs.writeFileSync(full, JSON.stringify(frozen, null, 2) + '\n');
      fs.chmodSync(full, f.mode);
    } else {
      fs.rmSync(full, {force:true, recursive:true});
      fs.copyFileSync(path.join(directory, f.path), full, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(full, f.mode);
    }
  }
}

/** User resume may restore approved acceptance bytes, never construct new acceptance. */
export function restoreEvaluatorAssets(cwd,directory,assets) {
  verifyEvaluatorAssets(directory,directory,assets);
  const expected=new Set(assets.files.map(f=>f.path)),removed=[];
  for(const f of inventory(cwd,{dependencies:true}))if(!expected.has(f.rel) &&
    (assets.directories.some(p=>f.rel===p || f.rel.startsWith(p+'/')) || !f.rel.split('/').includes('node_modules') && TEST_PATH.test(f.rel))) {
    fs.rmSync(safePath(cwd,f.rel,{allowFinalSymlink:true}),{force:true});removed.push(f.rel);
  }
  for(const rel of assets.dependencyBoundary?.absentPaths??[])if(fs.existsSync(safePath(cwd,rel))){
    fs.rmSync(safePath(cwd,rel),{recursive:true,force:true});removed.push(rel);
  }
  installEvaluatorAssets(cwd,directory,assets);
  verifyEvaluatorAssets(cwd,directory,assets);
  return {restored:assets.files.map(f=>f.path),removed};
}

/** Mutable product bytes are candidate inputs; pinned evaluator dependencies still must match. */
export function compatibleEnvironment(prepared, current, mutableDependencies = false, assets) {
  if (mutableDependencies && assets?.dependencyBoundary?.version !== 1) return false;
  const comparable = env => mutableDependencies ? Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'dependencies')) : env;
  return stable(comparable(prepared)) === stable(comparable(current));
}
