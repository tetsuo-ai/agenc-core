// Focused diagnostic comparison with unchanged test-support compiler options.
// Reads baseline test blobs in memory; no checkout mutation or type suppression.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
const runtime = '/private/tmp/light-takeover/startup-core/runtime';
process.chdir(runtime);
const ts = createRequire(resolve(runtime, 'package.json'))('typescript');
const config = ts.readConfigFile(resolve(runtime, 'tsconfig.test-support.json'), ts.sys.readFile);
if (config.error) throw Error('Cannot read test-support config');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, runtime);
const tests = ['tests/budget/admitted-model-call.test.ts', 'tests/budget/admitted-boundaries.integration.test.ts'];
const options = { ...parsed.options, incremental: false };
const roots = [...parsed.fileNames.filter(name => name.endsWith('.d.ts')), ...tests.map(name => resolve(runtime, name))];
const baseline = process.argv[2] === 'baseline';
const host = ts.createCompilerHost(options);
if (baseline) {
  const original = new Map(tests.map(name => [resolve(runtime, name), execFileSync('git',
    ['show', `45132f5aa0bb02ea4645c043bb9aa80370b6484a:runtime/${name}`], { cwd: runtime, encoding: 'utf8' })]));
  const read = host.readFile;
  host.readFile = name => original.get(resolve(name)) ?? read(name);
}
const program = ts.createProgram(roots, options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(d => ({
  file: d.file ? relative(runtime, d.file.fileName) : null,
  line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
  code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
}));
console.log(JSON.stringify({ baselineTests: baseline, diagnostics }, null, 2));
process.exitCode = diagnostics.length ? 1 : 0;
