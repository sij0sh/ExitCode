import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExitCode } from '../../exitcode-core.mjs';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-demo-'));
const local = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const requireOK = value => { if (!value.ok) throw new Error(JSON.stringify(value)); return value; };
try {
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'pending\n');
  const exitcode = new ExitCode(cwd);
  requireOK(await exitcode.start('The feature still reports pending'));
  requireOK(await exitcode.configure({ manifest: JSON.parse(local('manifest.json')), files: { 'driver.mjs': local('driver.mjs') } }));
  const preparation = requireOK(await exitcode.draft(JSON.parse(local('contract.json'))));
  requireOK(await exitcode.approve()); // Explicit simulated user approval in this demonstration only.
  const failing = requireOK(await exitcode.evaluate());
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'done\n'); // Stand-in for ordinary agent implementation.
  const passing = requireOK(await exitcode.evaluate());
  console.log(JSON.stringify({ preparation: preparation.phase, before: failing.status, after: passing.status, warmEnvironment: passing.run.warmEnvironment }, null, 2));
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
