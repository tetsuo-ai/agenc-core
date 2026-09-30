import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtime = resolve(process.argv[2]);
const fixtures = join(runtime, 'tests/durability/fixtures');
const require = createRequire(join(runtime, 'package.json'));
const ts = require('typescript');
const helperUrl = pathToFileURL(join(fixtures, 'm4-stage-diagnostics.mjs')).href;
const { createCollector } = await import(helperUrl);
const transpiled = [];
for (const name of ['tests/durability/failure-matrix.acceptance.test.ts',
  'tests/durability/fixtures/m4-failure-matrix-child.ts', 'tests/durability/fixtures/daemon-main-child.ts']) {
  const result = ts.transpileModule(readFileSync(join(runtime, name), 'utf8'), {
    fileName: name, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  assert.ok(result.outputText.length > 0);
  transpiled.push(name);
}
const collector = createCollector('crash');
const child = spawn(process.execPath, ['--loader', join(fixtures, 'node-test-loader.mjs'),
  '--import', join(fixtures, 'm4-stage-preload.mjs'), '--import', require.resolve('tsx'),
  fileURLToPath(new URL('./entry.ts', import.meta.url))], {
  cwd: runtime, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, NODE_ENV: 'test',
    AGENC_TEST_M4_DIAGNOSTIC_SCOPE: 'crash', M4_CHARACTERIZATION_HELPER: helperUrl },
});
let stdout = '', stderr = '', excessive = false, timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
function accumulate(kind, chunk) {
  if (kind === 'stdout') stdout += chunk; else stderr += chunk;
  if (stdout.length + stderr.length > 65536) { excessive = true; child.kill('SIGKILL'); }
}
child.stdout.on('data', chunk => accumulate('stdout', chunk));
child.stderr.on('data', chunk => accumulate('stderr', chunk));
child.stdio[3].on('data', chunk => collector.push(chunk));
const outcome = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code, signal }));
}).finally(() => clearTimeout(timer));
collector.end();
const report = collector.report();
// All subprocess text comes from synthetic fixtures, never Core sessions/keys.
if (outcome.code !== 0 || timedOut || excessive) {
  console.error(JSON.stringify({ outcome, timedOut, excessive, stdout, stderr, report }));
}
assert.equal(timedOut, false);
assert.equal(excessive, false);
assert.deepEqual(outcome, { code: 0, signal: null });
assert.deepEqual(JSON.parse(stdout), { mainScopeConsumed: true, workerResult: true, descendantResult: true });
assert.equal(report.evidence, 'observed_prefix_only');
assert.equal(report.records, 3);
assert.equal(report.lastObserved, 'paths_ready');
console.log(JSON.stringify({ passed: true, node: process.version, platform: process.platform,
  transpiled, semanticTypecheck: false, actualWorkerAndFork: true, report,
  limitation: 'synthetic wiring only; no M4 recovery or performance evidence; timers are not hard containment' }, null, 2));
