import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_STORE_DIR, fail, resolveStoreDir } from './exitcode-files.mjs';

export const DEFAULT_CONFIG = Object.freeze({ storeDir: DEFAULT_STORE_DIR, maxNudges: 2, showStatus: true });

export function parseConfig(source, file, cwd) {
  let value;
  try { value = JSON.parse(source); }
  catch { fail('INVALID_CONFIG', `${file}: expected valid JSON. Fix the file and run /reload.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONFIG', `${file}: expected a flat JSON object.`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_CONFIG, key)) fail('INVALID_CONFIG', `${file}: unknown setting ${key}. Use storeDir, maxNudges, or showStatus.`);
  if (Object.hasOwn(value, 'storeDir')) {
    try { resolveStoreDir(cwd, value.storeDir); }
    catch (error) { fail('INVALID_CONFIG', `${file}: storeDir: ${error.message}`); }
  }
  if (Object.hasOwn(value, 'maxNudges') && (!Number.isInteger(value.maxNudges) || value.maxNudges < 0 || value.maxNudges > 10))
    fail('INVALID_CONFIG', `${file}: maxNudges must be an integer from 0 through 10. Use 0 to disable automatic continuation.`);
  if (Object.hasOwn(value, 'showStatus') && typeof value.showStatus !== 'boolean') fail('INVALID_CONFIG', `${file}: showStatus must be true or false.`);
  return value;
}

// Load only on session start or reload. Reading settings never initializes a store.
export function loadConfig(cwd, { agentDir, projectTrusted = false }) {
  const sources = { user: { path: path.join(agentDir, 'exitcode.json'), loaded: false },
    project: { path: path.join(cwd, '.pi', 'exitcode.json'), loaded: false, trusted: projectTrusted } };
  let settings = { ...DEFAULT_CONFIG };
  for (const source of [sources.user, ...(projectTrusted ? [sources.project] : [])]) {
    let text;
    try { text = fs.readFileSync(source.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      fail('INVALID_CONFIG', `${source.path}: cannot read settings: ${error.message}`);
    }
    settings = { ...settings, ...parseConfig(text, source.path, cwd) }; source.loaded = true;
  }
  resolveStoreDir(cwd, settings.storeDir);
  return { settings: Object.freeze(settings), sources };
}
