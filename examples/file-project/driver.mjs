// A reusable driver observes the candidate. Expected values live in the contract.
import * as fs from 'node:fs';
import * as path from 'node:path';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const request = JSON.parse(stdin);
const reply = value => process.stdout.write(JSON.stringify({ protocol: 1, ...value }) + '\n');
if (['prepare', 'dispose'].includes(request.operation)) reply({ status: 'OK' });
else {
  const name = request.scenario.input.file;
  if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('..') || name.includes('\\')) reply({ status: 'ERROR', reason: 'file must be a confined filename' });
  else {
    const file = path.join(request.candidateDirectory, name);
    if (!fs.existsSync(file)) reply({ status: 'UNAVAILABLE', reason: 'Candidate file is absent' });
    else {
      const content = fs.readFileSync(file, 'utf8');
      fs.mkdirSync(path.join(request.runDirectory, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(request.runDirectory, 'artifacts', 'observed.txt'), content);
      reply({ status: 'OK', observations: { content }, artifacts: ['artifacts/observed.txt'] });
    }
  }
}
