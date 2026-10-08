/** Bounded evaluator recipes, discovery, and the executable isolation boundary. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RECIPE_KINDS = Object.freeze(['file_exists', 'file_contains', 'file_not_contains', 'json_value', 'existing_test', 'test_suite', 'build_succeeds', 'typecheck_succeeds', 'command_exit', 'custom_command']);
export const MUTATION_KINDS = Object.freeze(['write_file', 'delete_file', 'replace_text', 'copy_fixture', 'set_json_value']);
const RESERVED = new Set(['.exitcode', '.git', '.pi']);
const OMIT = new Set(['.exitcode', '.git', 'node_modules']);
const OUTPUT_CAP = 64 * 1024;
export const stable = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(stable).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
export const digest = x => createHash('sha256').update(typeof x === 'string' ? x : stable(x)).digest('hex');

export function diagnostic(code, stage, criterionId, evidence, recommendedRepair, repairability = 'agent') {
  return { code, stage, criterionId: criterionId ?? null, evidence: String(evidence), repairability, recommendedRepair };
}

export function safePath(cwd, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(p => p === '..' || RESERVED.has(p))) throw new Error(`unsafe candidate path: ${rel}`);
  const root = fs.realpathSync(cwd);
  let part = root;
  for (const name of rel.split('/')) {
    part = path.join(part, name);
    try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error(`symlink path forbidden: ${rel}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (part === root || !part.startsWith(root + path.sep)) throw new Error(`unsafe candidate path: ${rel}`);
  return part;
}

export function inventory(cwd, { dependencies = false } = {}) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((dependencies ? new Set(['.git', '.exitcode']) : OMIT).has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ rel, full, size: fs.statSync(full).size, mode: fs.statSync(full).mode & 0o777, sha: fileDigest(full) });
      else if (entry.isSymbolicLink()) files.push({ rel, full, link: fs.readlinkSync(full) });
      else throw new Error(`unsupported candidate file: ${rel}`);
    }
  };
  walk(cwd);
  return files;
}

// Full content identity, including executable modes and symlink targets. No sampling.
export function fileDigest(file) {
  const hash = createHash('sha256'); const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(1024 * 1024); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function candidateIdentity(cwd) { return digest(inventory(cwd).map(({rel,sha,size,mode,link}) => ({rel,sha,size,mode,link}))); }

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
    return { operation:'command', executable:'node', args:['--test','--test-reporter=tap',`--test-name-pattern=${escapeRegex(r.selector)}`,r.path], selectedTest:true };
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

export async function runRecipe(recipe, {cwd, timeoutMs = 120000, capabilities, exec = sandboxCommand} = {}) {
  try {
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
    const run = await exec(command,{cwd,timeoutMs,writable:true});
    if (compiled.selectedTest && run.exit === 0 && !/^# pass [1-9]\d*$/m.test(run.stdout)) return {...run,exit:1,stdout:run.stdout+'\nNo selected test executed'};
    return run;
  } catch (e) {
    if (['ENOENT','ENOTDIR'].includes(e.code) || e instanceof SyntaxError) return {exit:1,stdout:'invalid or missing target',stderr:e.message,timedOut:false};
    return {exit:null,stdout:'',stderr:'',error:e.message,timedOut:false};
  }
}

// Do not inherit credentials, NODE_OPTIONS, shell startup files, sockets, or host /proc.
// Only system runtime trees and the caller's independent fixture are mounted.
export function sandboxArgs(cwd, {writable = false} = {}) {
  const args = ['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/usr','/usr'];
  for (const name of ['lib','lib64','bin','sbin']) {
    const full = '/'+name;
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) args.push('--symlink',fs.readlinkSync(full),full);
    else args.push('--ro-bind',full,full);
  }
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/runtime','--ro-bind',fs.realpathSync(process.execPath),'/runtime/node');
  const npm = path.join(path.dirname(fs.realpathSync(process.execPath)), '../lib/node_modules/npm');
  if (fs.existsSync(npm)) args.push('--ro-bind',fs.realpathSync(npm),'/runtime/npm');
  args.push(writable?'--bind':'--ro-bind',fs.realpathSync(cwd),'/workspace','--chdir','/workspace','--clearenv','--setenv','PATH','/runtime:/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8');
  return args;
}

export async function sandboxCommand(command, {cwd,timeoutMs = 120000,bwrapPath = '/usr/bin/bwrap',writable = false} = {}) {
  const started = Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return {exit:null,stdout:'',stderr:'',timedOut:false,error:'finite positive timeout required'};
  let args;
  try { fs.accessSync(bwrapPath,fs.constants.X_OK); args=sandboxArgs(cwd,{writable}); }
  catch(e) {return {exit:null,stdout:'',stderr:'',timedOut:false,error:`isolation unavailable: ${e.message}`,durationMs:Date.now()-started};}
  // Runtime npm is explicit and read-only. Its wrapper lives only in the sandbox tmpfs.
  const wrapper = 'mkdir -p /tmp/bin; printf \'#!/bin/sh\\nexec /runtime/node /runtime/npm/bin/npm-cli.js "$@"\\n\' > /tmp/bin/npm; chmod 700 /tmp/bin/npm; export PATH=/tmp/bin:$PATH; ';
  return new Promise(resolve => {
    const child = spawn(bwrapPath,[...args,'/bin/sh','-c',wrapper+command],{stdio:['ignore','pipe','pipe'],env:{},detached:true});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false,done=false;
    const append=(buf,x)=>{ const result=Buffer.concat([buf,x]); if(result.length>OUTPUT_CAP){truncated=true;return result.subarray(result.length-OUTPUT_CAP);}return result; };
    child.stdout.on('data',x=>stdout=append(stdout,x));child.stderr.on('data',x=>stderr=append(stderr,x));
    const finish=r=>{if(done)return;done=true;clearTimeout(timer);resolve({...r,stdout:stdout.toString(),stderr:stderr.toString(),durationMs:Date.now()-started,truncated});};
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')child.kill('SIGKILL');}finish({exit:null,timedOut:true});},timeoutMs);
    child.on('error',e=>finish({exit:null,timedOut:false,error:`isolation unavailable: ${e.message}`}));
    child.on('close',(exit,signal)=>finish({exit,timedOut:false,...(signal||/^bwrap:/m.test(stderr.toString())?{error:`isolation failed: ${stderr.toString()||signal}`}:{})}));
  });
}

export function evaluatorEnvironment(cwd) {
  const runtime = [process.execPath,'/usr/bin/bwrap','/bin/sh'].map(p=>{try{return {path:p,digest:fileDigest(fs.realpathSync(p))};}catch(e){return {path:p,error:e.code};}});
  const npm = path.join(path.dirname(fs.realpathSync(process.execPath)), '../lib/node_modules/npm');
  return {platform:os.platform(),release:os.release(),arch:os.arch(),node:process.version,runtime,
    npm:fs.existsSync(npm)?candidateIdentity(npm):null,
    dependencies:fs.existsSync(path.join(cwd,'node_modules'))?digest(inventory(path.join(cwd,'node_modules'),{dependencies:true}).map(({rel,sha,mode,link})=>({rel,sha,mode,link}))):null,
    runnerVersion:1};
}

export function auditIntent({criteria = [],intentAtoms = [],ambiguities = []}) {
  const diagnostics=[],ids=new Set(criteria.map(c=>c.id)),seen=new Set();
  const add=(code,evidence,id=null)=>diagnostics.push(diagnostic(code,'intent',id,evidence,'Correct the declared outcome coverage or criterion before review'));
  for(const c of criteria){const norm=c.requirement?.trim().replace(/\s+/g,' ').toLowerCase();if(seen.has(norm))add('DUPLICATE_CRITERION',c.requirement,c.id);seen.add(norm);}
  if(!Array.isArray(intentAtoms)||!intentAtoms.length)add('INTENT_UNCOVERED','Declare materially distinct request outcomes');
  const atomIds=new Set();
  for(const atom of intentAtoms){
    if(!atom.id||atomIds.has(atom.id)||typeof atom.outcome!=='string'||!atom.outcome.trim())add('INTENT_UNCOVERED','Invalid or duplicate intent atom');atomIds.add(atom.id);
    if(!Array.isArray(atom.criteria)||!atom.criteria.length||atom.criteria.some(c=>!ids.has(c)))add('INTENT_UNCOVERED',`${atom.id}: missing or unknown criterion mapping`);
  }
  const questions=(Array.isArray(ambiguities)?ambiguities:[]).filter(a=>a.unresolved===true&&typeof a.question==='string'&&a.question.trim()&&new Set(a.plausibleAnswers?.filter(x=>typeof x==='string'&&x.trim())).size>1&&typeof a.whyMaterial==='string'&&a.whyMaterial.trim()&&a.affectedCriteria?.length&&a.affectedCriteria.every(c=>ids.has(c))).slice(0,3);
  return {ok:diagnostics.length===0,diagnostics,questions,coverage:intentAtoms.map(a=>({intentId:a.id,criteria:a.criteria}))};
}

export function lintEvaluators(draft, cwd, capabilities) {
  const diagnostics=[];
  for(const c of draft.criteria){
    const recipe=c.check.recipe;
    try {
      if(recipe){compileRecipe(recipe,capabilities);if(recipe.path)safePath(cwd,recipe.path);}
      for(const control of [c.controls?.accept,...(c.controls?.reject??[])].filter(Boolean))for(const mutation of control.mutations??[]){validateMutation(mutation);safePath(cwd,mutation.path);if(mutation.kind==='copy_fixture')safePath(cwd,mutation.from);}
    }catch(e){const code=e.message.split(':')[0];diagnostics.push(diagnostic(['RUNNER_NOT_FOUND','CHECK_TARGET_MISSING','TEST_SELECTOR_NOT_FOUND'].includes(code)?code:'UNSAFE_COMMAND','lint',c.id,e.message,'Use a discovered runner, literal selector, and confined fixture paths'));}
    const command=recipe?.command??c.check.command??'';
    if(/https?:\/\/|\b(?:curl|wget|ssh|nc|sudo)\b/.test(command))diagnostics.push(diagnostic('EXTERNAL_DEPENDENCY','lint',c.id,'External or privileged command','Use local deterministic evidence'));
    if(recipe?.path&&['file_exists','file_contains','file_not_contains','json_value'].includes(recipe.kind)){
      const present=fs.existsSync(safePath(cwd,recipe.path));
      const supplied=c.controls?.accept?.mutations?.some(m=>m.path===recipe.path&&['write_file','copy_fixture'].includes(m.kind));
      if(!present&&!supplied)diagnostics.push(diagnostic('CHECK_TARGET_MISSING','lint',c.id,recipe.path,'Supply the target in the valid fixture'));
    }
  }
  return diagnostics;
}

export function normalizeEvaluator(draft, defaultSeconds) {
  const normalized=structuredClone(draft),repairs=[];
  for(const c of normalized.criteria){
    if(c.check.recipe?.kind==='existing_test'&&c.check.recipe.runner==='discovered'){delete c.check.recipe.runner;repairs.push({criterionId:c.id,repair:'Use discovered node:test runner'});}
    if(typeof c.check.timeoutSeconds==='string'&&/^\d+(\.\d+)?$/.test(c.check.timeoutSeconds)){c.check.timeoutSeconds=Number(c.check.timeoutSeconds);repairs.push({criterionId:c.id,repair:'Normalize numeric timeout'});}
    if(c.check.timeoutSeconds>defaultSeconds){c.check.timeoutSeconds=defaultSeconds;repairs.push({criterionId:c.id,repair:'Bound timeout to policy'});}
  }
  return {draft:normalized,repairs};
}
