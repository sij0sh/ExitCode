import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { workspace } from './helpers.mjs';

const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

export async function harness(t, { user, project, trusted = true, mode = 'tui' } = {}) {
  const cwd = workspace(t), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-agent-test-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const files = { user: path.join(agentDir, 'exitcode.json'), project: path.join(cwd, '.pi', 'exitcode.json') };
  const settings = (scope, value) => {
    fs.mkdirSync(path.dirname(files[scope]), { recursive: true });
    fs.writeFileSync(files[scope], typeof value === 'string' ? value : JSON.stringify(value));
  };
  if (user !== undefined) settings('user', user);
  if (project !== undefined) settings('project', project);
  const sdk = dataUrl(`export const getAgentDir = () => ${JSON.stringify(agentDir)};`);
  const schema = dataUrl('export const Type = new Proxy({}, { get: () => () => ({}) });');
  const source = stripTypeScriptTypes(fs.readFileSync(new URL('../exitcode.ts', import.meta.url), 'utf8'))
    .replace(/(from\s+["'])([^"']+)(["'])/g, (_all, before, name, after) => {
      const target = name === '@earendil-works/pi-coding-agent' ? sdk : name === 'typebox' ? schema
        : name.startsWith('.') ? new URL('../' + name.replace(/^\.\//, ''), import.meta.url).href : name;
      return before + target + after;
    });
  const install = (await import(dataUrl(source))).default;
  const tools = new Map(), events = new Map(), commands = new Map(), entries = [], messages = [], notices = [], statuses = new Map(), updates = [];
  let active = ['read', 'write', 'bash', 'other'], loaded = false, idle = true;
  const pi = {
    registerTool: definition => tools.set(definition.name, definition), on: (name, handler) => events.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    getActiveTools: () => { assert.ok(loaded, 'factory must not call session APIs'); return active; }, setActiveTools: value => { active = value; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: content => messages.push({ content }), sendMessage: (message, options) => messages.push({ ...message, ...options }),
  };
  const ctx = { cwd, mode, hasUI: mode === 'tui' || mode === 'rpc', isIdle: () => idle, isProjectTrusted: () => trusted,
    ui: { notify: (text, kind) => { assert.ok(['info', 'warning', 'error'].includes(kind)); notices.push({ text, kind }); },
      setStatus: (key, text) => { assert.equal(mode, 'tui'); updates.push({ key, text }); if (text === undefined) statuses.delete(key); else statuses.set(key, text); } },
    sessionManager: { getBranch: () => entries } };
  install(pi); loaded = true;
  return { cwd, agentDir, files, settings, ctx, tools, events, entries, messages, notices, statuses, updates, active: () => active,
    setIdle: value => { idle = value; }, start: () => events.get('session_start')({}, ctx), command: args => commands.get('exitcode').handler(args, ctx),
    complete: prefix => commands.get('exitcode').getArgumentCompletions?.(prefix) ?? null,
    call: (name, params = {}) => tools.get(name).execute('call', params, undefined, undefined, ctx),
    guard: (toolName, input) => events.get('tool_call')({ toolName, input }, ctx),
    reload: () => { loaded = false; install(pi); loaded = true; return events.get('session_start')({}, ctx); } };
}

export const footer = h => [...h.statuses.values()].join(' ');
