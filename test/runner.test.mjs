import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invoke } from '../exitcode-runner.mjs';
import { compare, validateContract, validateProject } from '../exitcode-spec.mjs';
import { workspace, manifest, contract } from './helpers.mjs';

function request(t, source) {
  const root = workspace(t);
  for (const name of ['project', 'runtime', 'candidate', 'run']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'project', 'driver.mjs'), source);
  return { protocol: 1, operation: 'run', projectDirectory: path.join(root, 'project'), runtimeDirectory: path.join(root, 'runtime'), candidateDirectory: path.join(root, 'candidate'), runDirectory: path.join(root, 'run') };
}

test('runner accepts JSON protocol, records external time, and excludes undeclared credentials', async t => {
  process.env.EXITCODE_TEST_SECRET = 'do-not-inherit'; t.after(() => delete process.env.EXITCODE_TEST_SECRET);
  const req = request(t, "console.log(JSON.stringify({protocol:1,status:'OK',observations:{secret:process.env.EXITCODE_TEST_SECRET??null,home:process.env.HOME}}));");
  const result = await invoke(manifest, req);
  assert.equal(result.report.observations.secret, null);
  assert.equal(result.report.observations.home, path.join(req.runDirectory, 'home'));
  assert.ok(result.processResult.elapsedMs > 0);
});

test('timeout and cancellation stop a real process and never yield evidence', async t => {
  const req = request(t, "setInterval(()=>{},1000);");
  await assert.rejects(invoke(manifest, req, { timeoutSeconds: 0.05 }), error => error.code === 'DRIVER_TIMEOUT');
  const controller = new AbortController();
  const running = invoke(manifest, req, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, error => error.code === 'CANCELLED');
});

test('nonzero exit, prose output, and output overflow are typed infrastructure failures', async t => {
  for (const [source, code] of [["process.exit(3)", 'RUNNER_ERROR'], ["console.log('Here is JSON: {}')", 'INVALID_REPORT'], ["process.stdout.write('x'.repeat(2*1024*1024))", 'OUTPUT_LIMIT']]) {
    await assert.rejects(invoke(manifest, request(t, source)), error => error.code === code);
  }
});

test('bubblewrap never silently falls back to a host process', async t => {
  const req = request(t, "console.log(JSON.stringify({protocol:1,status:'OK',observations:{home:process.env.HOME}}));");
  try {
    const result = await invoke({ ...manifest, isolation: 'bubblewrap' }, req);
    assert.equal(result.report.observations.home, '/tmp');
  } catch (error) { assert.equal(error.code, 'ISOLATION_UNAVAILABLE'); }
});

test('assertions distinguish a measured failure from missing or malformed measurements', () => {
  assert.equal(compare({ elapsed: 2000 }, [{ path: '/elapsed', op: 'lte', value: 1000 }])[0].status, 'FAIL');
  assert.throws(() => compare({}, [{ path: '/elapsed', op: 'lte', value: 1000 }]), error => error.code === 'INVALID_OBSERVATION');
  assert.throws(() => compare({ elapsed: 'fast' }, [{ path: '/elapsed', op: 'lte', value: 1000 }]), error => error.code === 'INVALID_OBSERVATION');
  assert.equal(compare({ 'a/b': { '~key': 7 } }, [{ path: '/a~1b/~0key', op: 'eq', value: 7 }])[0].status, 'PASS');
  assert.equal(compare({}, [{ path: '/optional', op: 'present' }])[0].status, 'FAIL');
  assert.throws(() => validateProject({ manifest: { ...manifest, environment: ['NODE_OPTIONS'] }, files: { 'driver.mjs': '' } }), error => error.code === 'INVALID_SPEC');
  const value = contract(); value.scenarios[0].assertions[0].path = '/broken~2pointer';
  assert.throws(() => validateContract(value), error => error.code === 'INVALID_SPEC');
});

test('invalid protocol replies name valid statuses and unknown keys without accepting alternate syntax', async t => {
  for (const report of [null, [], 'ready', { protocol: 1, status: 'ready', ok: true }, { protocol: 2, status: 'OK' }]) {
    const source = `console.log(${JSON.stringify(JSON.stringify(report))});`;
    await assert.rejects(invoke(manifest, request(t, source)), error => {
      assert.equal(error.code, 'INVALID_REPORT');
      assert.match(error.message, /protocol: 1/); assert.match(error.message, /OK, UNAVAILABLE, ERROR/);
      if (report?.ok) assert.match(error.message, /Unknown keys: "ok"/);
      assert.equal(error.processResult.exit, 0);
      return true;
    });
  }
});
