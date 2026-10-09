import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [suite = 'baseline', ...options] = process.argv.slice(2);
if (!['baseline', 'full'].includes(suite)) throw new Error(`Unknown test suite: ${suite}`);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(cwd).filter(name => name.endsWith('.test.mjs')).sort();
const result = spawnSync(process.execPath, ['--test', ...options, ...files], {
  cwd, stdio: 'inherit', env: { ...process.env, EXITCODE_TEST_SUITE: suite },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
