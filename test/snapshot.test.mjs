import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileSha, sha, inventory, copyTree, treeDigest, MAX_TREE_BYTES } from '../exitcode-files.mjs';
import { workspace } from './helpers.mjs';

const tooLarge = error => error.code === 'TREE_TOO_LARGE';
const cancelled = error => error.code === 'CANCELLED';
function sizedFile(root, name, bytes) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'w');
  try { fs.ftruncateSync(descriptor, bytes); }
  finally { fs.closeSync(descriptor); }
  return file;
}
function child(source, args, timeout = 10000) {
  const imports = `import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { createHash } from 'node:crypto';
    import { fileSha, inventory, copyTree, treeDigest, MAX_TREE_BYTES } from ${JSON.stringify(new URL('../exitcode-files.mjs', import.meta.url).href)};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', imports + source, ...args], { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('chunked hashing preserves full SHA-256 identity for empty files and partial chunks', t => {
  const root = workspace(t), file = path.join(root, 'bytes.bin');
  for (const size of [0, 1, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 2 * 1024 * 1024 + 17]) {
    const content = Buffer.alloc(size);
    for (let index = 0; index < content.length; index++) content[index] = index % 251;
    fs.writeFileSync(file, content);
    assert.equal(fileSha(file), sha(content));
    assert.equal(inventory(root).find(entry => entry.path === 'bytes.bin').sha, sha(content));
  }
  const before = treeDigest(root), descriptor = fs.openSync(file, 'r+');
  try { fs.writeSync(descriptor, Buffer.from([0xff]), 0, 1, 1024 * 1024 + 29); }
  finally { fs.closeSync(descriptor); }
  assert.notEqual(treeDigest(root), before);
});

test('default product snapshots handle a 768 MiB artifact with bounded memory and independent copies', t => {
  const root = workspace(t), destination = workspace(t);
  fs.rmSync(path.join(destination, 'feature.txt'));
  const file = sizedFile(root, 'target/artifact.bin', 768 * 1024 * 1024), descriptor = fs.openSync(file, 'r+');
  try { for (const offset of [0, 384 * 1024 * 1024, 768 * 1024 * 1024 - 1]) fs.writeSync(descriptor, Buffer.from([0x61]), 0, 1, offset); }
  finally { fs.closeSync(descriptor); }
  assert.throws(() => inventory(root), tooLarge); // Evaluator trees retain their existing default limit.
  const observations = JSON.parse(child(`
    const root = process.argv[1], destination = process.argv[2], options = { candidate: true };
    const file = path.join(root, 'target/artifact.bin'), hash = createHash('sha256');
    const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let bytes; while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
    finally { fs.closeSync(descriptor); }
    const expected = hash.digest('hex'), entry = inventory(root, options).find(entry => entry.path === 'target/artifact.bin');
    const before = treeDigest(root, options), copied = copyTree(root, destination, options);
    const copyMatches = treeDigest(destination, { maxBytes: Infinity }) === before && copied === before;
    const edit = fs.openSync(path.join(destination, 'target/artifact.bin'), 'r+');
    try { fs.writeSync(edit, Buffer.from([0x78]), 0, 1, 384 * 1024 * 1024 + 17); }
    finally { fs.closeSync(edit); }
    console.log(JSON.stringify({ fullHash: entry.sha === expected, bytes: entry.bytes, copyMatches,
      independent: treeDigest(root, options) === before, copyChanged: treeDigest(destination, { maxBytes: Infinity }) !== before,
      peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
  `, [root, destination], 60000));
  assert.equal(observations.bytes, 768 * 1024 * 1024);
  for (const key of ['fullHash', 'copyMatches', 'independent', 'copyChanged']) assert.equal(observations[key], true, key);
  assert.ok(observations.peakRssMiB <= 384, `Peak resident memory: ${observations.peakRssMiB} MiB`);
});

test('explicit byte budgets retain ignored inputs, exclude only metadata, and reject before copying', t => {
  const root = workspace(t), destination = workspace(t), rejected = path.join(destination, 'rejected');
  fs.rmSync(path.join(destination, 'feature.txt'));
  sizedFile(root, '.git/excluded.bin', MAX_TREE_BYTES + 1);
  sizedFile(root, '.cache/validation/state/excluded.bin', MAX_TREE_BYTES + 1);
  fs.writeFileSync(path.join(root, '.cache/product.txt'), 'product');
  fs.writeFileSync(path.join(root, '.gitignore'), '.cache/\n');
  const options = { candidate: true, storeDir: '.cache/validation', maxBytes: 23 };
  assert.equal(inventory(root, options).filter(entry => entry.kind === 'file').length, 3);
  copyTree(root, destination, options);
  assert.equal(fs.readFileSync(path.join(destination, '.cache/product.txt'), 'utf8'), 'product');
  assert.throws(() => copyTree(root, rejected, { ...options, maxBytes: 22 }), tooLarge);
  assert.ok(!fs.existsSync(rejected));
  child(`
    fs.readSync = () => { throw new Error('Content read before budget rejection'); };
    syncBuiltinESMExports();
    try { inventory(process.argv[1], { maxBytes: 1 }); process.exit(1); }
    catch (error) { if (error.code !== 'TREE_TOO_LARGE') throw error; }
  `, [root]);
});

test('copy verification uses the product or explicit budget rather than the evaluator default', t => {
  const root = workspace(t), destinations = [workspace(t), workspace(t)];
  for (const destination of destinations) fs.rmSync(path.join(destination, 'feature.txt'));
  // Model large logical sizes cheaply; the real large-file test above covers full content and memory.
  child(`
    const original = fs.lstatSync;
    fs.lstatSync = (...args) => {
      const stat = original(...args);
      if (stat?.isFile()) stat.size = MAX_TREE_BYTES * 20;
      return stat;
    };
    syncBuiltinESMExports();
    copyTree(process.argv[1], process.argv[2], { candidate: true });
    copyTree(process.argv[1], process.argv[3], { maxBytes: MAX_TREE_BYTES * 20 });
  `, [root, ...destinations]);
  for (const destination of destinations) assert.equal(fs.readFileSync(path.join(destination, 'feature.txt'), 'utf8'), 'pending\n');
});

test('hashing checks cancellation between chunks and closes its file descriptor', t => {
  const root = workspace(t), file = sizedFile(root, 'bytes.bin', 2 * 1024 * 1024);
  const observations = JSON.parse(child(`
    const read = fs.readSync, close = fs.closeSync, controller = new AbortController();
    let reads = 0, closed = false;
    fs.readSync = (...args) => { const bytes = read(...args); reads++; controller.abort(); return bytes; };
    fs.closeSync = descriptor => { closed = true; return close(descriptor); };
    syncBuiltinESMExports();
    let code;
    try { fileSha(process.argv[1], { signal: controller.signal }); }
    catch (error) { code = error.code; }
    console.log(JSON.stringify({ code, reads, closed }));
  `, [file]));
  assert.deepEqual(observations, { code: 'CANCELLED', reads: 1, closed: true });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => fileSha(path.join(root, 'absent'), { signal: controller.signal }), cancelled);
  assert.throws(() => inventory(root, { signal: controller.signal }), cancelled);
});
