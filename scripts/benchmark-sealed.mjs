/** Two independent slices, injected checks/workers, real candidate capture and integration. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '../exitcode-core.mjs';
import { releasePreparation } from '../exitcode-preparation.mjs';
import { structuralReview } from '../test/structural-review.mjs';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exitcode-sealed-benchmark-'));
const read = (directory, file) => fs.existsSync(path.join(directory, file)) ? fs.readFileSync(path.join(directory, file), 'utf8') : null;
const write = (directory, file, value) => fs.writeFileSync(path.join(directory, file), value);
const counts = { C1: 0, C2: 0, R1: 0 };
try {
  write(cwd, 'first', 'pending'); write(cwd, 'second', 'pending'); write(cwd, 'stable', 'steady');
  const io = core.makeIo(cwd, {
    review: structuralReview,
    exec: async (command, options) => {
      counts[command]++;
      const [file, expected] = command === 'R1' ? ['stable', 'steady'] : [command === 'C1' ? 'first' : 'second', 'done'];
      return { exit: read(options.cwd, file) === expected ? 0 : 1, stdout: '', stderr: '', timedOut: false };
    },
  });
  io.workerBackend = {
    async preflight() {},
    async start(spec) { return spec; },
    async send(spec) { write(spec.cwd, spec.id === 'S1' ? 'first' : 'second', 'done'); },
    async cancel() {}, async dispose() {},
  };
  const drafted = core.draftNode(io, {
    goal: 'Finish two independent artifacts',
    outcomes: [{id:'O1',requirement:'First artifact is done'}, {id:'O2',requirement:'Second artifact is done'}],
    criteria: [
      ...['C1','C2'].map((id, index) => ({ id, outcome:`O${index+1}`,
        check:{recipe:{kind:'custom_command',command:id}},
        controls:{accept:{mutations:[{kind:'write_file',path:index===0?'first':'second',content:'done'}]}} })),
      {id:'R1',type:'regression',requirement:'Stable artifact stays steady',check:{recipe:{kind:'custom_command',command:'R1'}}},
    ],
    execution: [{id:'S1',objective:'Finish first artifact',verify:['C1']}, {id:'S2',objective:'Finish second artifact',verify:['C2']}],
  });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  const prepared = await core.prepareNode(io);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal((await core.sealNode(io, 'G1', {userApproval:'Approve benchmark graph'})).ok, true);
  for (const id of Object.keys(counts)) counts[id] = 0;
  const started = performance.now();
  const result = await core.evaluateNode(io);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  console.log(JSON.stringify({totalMs:performance.now()-started, counts, metrics:core.loadRoot(io,'G1').execution.metrics}, null, 2));
} finally {
  releasePreparation(cwd);
  fs.rmSync(cwd, {recursive:true,force:true});
}
