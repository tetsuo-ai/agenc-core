import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [study, phase, before, after, output] = process.argv.slice(2);
const moduleAt = (tree) => import(pathToFileURL(join(tree, 'runtime/src/tools/untrusted-tool-result-framing.ts')));
const old = await moduleAt(before);
const current = await moduleAt(after);
let requests = 0, results = 0, differences = 0;
const runs = [];
for (const name of (await readdir(join(study, 'runs'))).sort()) {
  if (!name.startsWith(phase + '-')) continue;
  const folder = join(study, 'runs', name);
  const record = JSON.parse(await readFile(join(folder, 'result.json'), 'utf8'));
  runs.push({ id: name, revision: record.agent_revision });
  for (const file of (await readdir(folder)).filter(name => /^wire-\d+\.json$/.test(name))) {
    const { body } = JSON.parse(await readFile(join(folder, file), 'utf8'));
    const names = new Map();
    requests++;
    for (const message of body.messages) {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      if (message.role !== 'tool') continue;
      const tool = names.get(message.tool_call_id);
      if (!tool) throw new Error('Tool identity is absent from the captured request');
      const kind = old.classifyUntrustedToolResult(tool);
      const a = old.frameUntrustedToolResultContent(tool, message.content, kind, true);
      const b = current.frameUntrustedToolResultContent(tool, message.content, kind, true);
      results++;
      if (JSON.stringify(a) !== JSON.stringify(b)) differences++;
    }
  }
}
if (runs.length !== 8) throw new Error('Screening cohort is incomplete');
const report = { phase, runs, requests, replayed_results: results, differing_results: differences,
  limitation: 'Replay comparison on captured results, not a new stochastic model run. The only post-screen source change recognizes legacy full frames containing the new marker as data. No prior run is overwritten.' };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ requests, replayed_results: results, differing_results: differences }));
if (differences) process.exitCode = 1;
