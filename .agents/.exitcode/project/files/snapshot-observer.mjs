import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const request = JSON.parse(stdin);
const reply = value => console.log(JSON.stringify({ protocol: 1, ...value }));
function confined(name) {
  if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe fixture path');
  return path.join(request.candidateDirectory, name);
}
function hash(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), sha = createHash('sha256');
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) sha.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return sha.digest('hex');
}
try {
  if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });
  else if (!fs.existsSync(confined('feature.txt'))) reply({ status: 'UNAVAILABLE', reason: 'Fixture feature is absent' });
  else {
    const input = request.scenario.input, content = fs.readFileSync(confined('feature.txt'), 'utf8');
    const files = input.fileNames.map(name => {
      const file = confined(name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
      return stat?.isFile() ? { path: name, bytes: stat.size, mode: stat.mode & 0o777, sha: hash(file) } : { path: name, missing: true };
    });
    const linkTarget = fs.lstatSync(confined(input.link), { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(confined(input.link)) : null;
    const gitIncluded = fs.existsSync(confined('.git')), storeIncluded = fs.existsSync(confined('.agents/.exitcode'));
    fs.appendFileSync(confined('src/lib.rs'), '// disposable edit\n');
    let mutatedCopies = false;
    if (fs.existsSync(confined(input.mutationFile))) {
      const fd = fs.openSync(confined(input.mutationFile), 'r+');
      try { fs.writeSync(fd, Buffer.from([0x78]), 0, 1, 37); mutatedCopies = true; }
      finally { fs.closeSync(fd); }
    }
    reply({ status: 'OK', observations: { content, files, linkTarget, gitIncluded, storeIncluded, mutatedCopies } });
  }
} catch (error) { reply({ status: 'ERROR', reason: error.message }); }
