import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
const runtime = resolve(process.argv[2]);
process.chdir(runtime);
const require = createRequire(join(runtime, 'package.json'));
const ts = require('typescript');
const explicit = ['tests/durability/failure-matrix.acceptance.test.ts',
  'tests/durability/fixtures/m4-failure-matrix-child.ts', 'tests/durability/fixtures/daemon-main-child.ts'];
const config = ts.readConfigFile(join(runtime, 'tsconfig.test-support.json'), ts.sys.readFile);
if (config.error) throw new Error('config error');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, runtime);
// The M4 test imports the SDK's actual source outside runtime/rootDir. Widen the
// source root and resolve the package to that same source, not an unbuilt dist or
// stub. This is an explicit fixture check, not the repository's default gate.
const options = { ...parsed.options, noEmit: true, preserveSymlinks: true, incremental: false,
  rootDir: resolve(runtime, '..'),
  paths: { ...parsed.options.paths, '@tetsuo-ai/agenc-sdk': [join(runtime, '../packages/agenc-sdk/src/index.ts')] },
};
const host = ts.createCompilerHost(options);
if (process.argv[3]) {
  const pin = process.argv[3];
  if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error('full commit required');
  const originals = new Map(explicit.map(name => [join(runtime, name), execFileSync('git',
    ['-C', runtime, 'show', `${pin}:runtime/${name}`], { encoding: 'utf8', maxBuffer: 1048576 })]));
  const read = host.readFile;
  host.readFile = name => originals.get(resolve(name)) ?? read(name);
}
const program = ts.createProgram([...parsed.fileNames.filter(x => x.endsWith('.d.ts')),
  ...explicit.map(name => join(runtime, name))], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
  file: d.file ? relative(runtime, d.file.fileName) : null, code: d.code,
  message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
}));
console.log(JSON.stringify({ source: process.argv[3] ?? 'working-tree', explicit,
  config: 'test-support plus repository rootDir and canonical SDK-source resolution; no stubs', diagnostics }, null, 2));
process.exitCode = diagnostics.length ? 1 : 0;
