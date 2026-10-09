import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExitCode } from '../exitcode-core.mjs';

export const driver = fs.readFileSync(new URL('../examples/file-project/driver.mjs', import.meta.url), 'utf8');
export const manifest = JSON.parse(fs.readFileSync(new URL('../examples/file-project/manifest.json', import.meta.url), 'utf8'));
export const contract = () => JSON.parse(fs.readFileSync(new URL('../examples/file-project/contract.json', import.meta.url), 'utf8'));
export const ok = value => { if (!value.ok) throw new Error(JSON.stringify(value)); return value; };
export function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'pending\n');
  return cwd;
}
export async function ready(t, options = {}) {
  const cwd = workspace(t), supervisor = new ExitCode(cwd, options);
  const started = ok(await supervisor.start('The feature is pending'));
  ok(await supervisor.configure({ manifest, files: { 'driver.mjs': options.driver ?? driver } }));
  const prepared = ok(await supervisor.draft(contract()));
  return { cwd, supervisor, id: started.task, prepared };
}
