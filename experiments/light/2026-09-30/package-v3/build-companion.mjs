// DRAFT build-only recipe. No emitted-module import, client, provider or launcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source';
const RUNTIME = path.join(CORE, 'runtime');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAIR = path.dirname(HERE);
const REVISION = '403da04398b55e51d1f4e8814f9a70957b0db5ef';
const NODE = '/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node';
const SHA = /^[a-f0-9]{64}$/;
let phase = 'validate_arguments';
let ownedOutput = null;
const FIXED = {
  [NODE]: 'ebd2d552c7bebde593dd0390530963ad28de56bccde6ce387cdbe55fb0b6fb8e',
  [path.join(RUNTIME, 'build.config.ts')]: 'b34f5c7fa761269447aa645385380c883574b436fcb096b45c398d872c702558',
  [path.join(RUNTIME, 'scripts/build-runtime.mjs')]: 'c2b64c66c44abf13b6203237b6d1341ac5f70b80686089959c47bef11b956aec',
  [path.join(RUNTIME, 'tsconfig.bundle.json')]: 'ae3c771a0aff86f224b5acc5ab1e83d732fb27af736d21ea613298bc000c14bc',
  [path.join(RUNTIME, 'tsconfig.json')]: '56d79bc0d4f12d423c48139828f1e057b67bd964152808d9bde530e0f1342420',
  [path.join(RUNTIME, 'package.json')]: '2df33a01ebf17b7d285d73b0862af5be26251c53485d1fdac42e6a7ed7b9f086',
  [path.join(RUNTIME, 'src/build/feature.ts')]: 'ac2e0d25f8f5af58f32ec2ea339aabc720b07f5ff9754691573a46ec40438ed9',
  [path.join(RUNTIME, 'dist/VERSION')]: '423b01c23709f5396ef77d60e7c09091745a059602ddd8f4f1c2d98bb03f6084',
  [path.join(RUNTIME, 'dist/yolo-classifier-prompts/auto_mode_system_prompt.txt')]: 'd64e592c108021545b57c58a1142e420268dee7b8c2a67a9c02c6fe84bbb8f75',
  [path.join(RUNTIME, 'dist/yolo-classifier-prompts/permissions_external.txt')]: '7400210358e165cb2d1ba4d18e08fdbbde303a3223040f6d8e9de9c674c1300b',
  [path.join(CORE, 'package-lock.json')]: 'a6d4ca9885fc8fea507135919a7677b682b629b5a3887b4dcb665a058e8ddd94',
  [path.join(CORE, 'node_modules/esbuild/lib/main.js')]: '8331fe1d8b3a07381f33cc425fcfaa94776e263113653f80ec3ba433e9657e73',
  [path.join(CORE, 'node_modules/esbuild/package.json')]: 'd55d1d19fcc5b6079e4a71dd4111340c79c682bc36835ac7058a0c364c7db58a',
  [path.join(CORE, 'node_modules/@esbuild/darwin-arm64/bin/esbuild')]: 'e2dc9a52440a2a34f09434a2f4843cb1e30f84e40dcf238976ec61ef8cd7f36a',
  [path.join(HERE, 'owner-entry.ts')]: '680231dce925644253f02a561f0b5020f13a7b4bb1aebdcd61419f917e8eaef1',
  [path.join(HERE, 'companion-validator.ts')]: '95c96544107846974dd9663796354b82cd592ad4b75c25df5f750ccea912a27b',
  [path.join(HERE, 'selection.mjs')]: 'd3ede932b460525dccc1f15eef01a13aee6ec2030d30dadc068c81244cb3a0f6',
  [path.join(HERE, 'compatibility-selection.mjs')]: '4d64a68689ec07db0a92bf1a73358c406953bff7d2285ad47ad258c3931d6d77',
  [path.join(HERE, 'empty-resources.mjs')]: '48dcec5348328bc0e4507f83cf3a4b6b21df935f69d2c8da3af5aef34fd4a972',
  [path.join(HERE, 'preflight-entry.ts')]: 'cce66cfcd3c2bb0fb3049b93f9f46cc5371f4d71b866d6bc0ac6f0cd687b5c97',
  [path.join(HERE, 'preflight.ts')]: 'fad448e9bff8199ab5881669558a8fc6651f5d96ed69e929c1506059bd69df4f',
  [path.join(HERE, 'preflight-selection.mjs')]: '4213db8e45d9f65b940d32f5000c2debcb7d472e1ba9945addffde87d4384d9c',
  [path.join(FAIR, 'luna-observer-v6/direct.mjs')]: '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
};
const sha = value => createHash('sha256').update(value).digest('hex');
const within = (root, file) => file === root || file.startsWith(root + '/');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function inspect(file, collect = false, limit = 256 * 1024 * 1024) {
  assert(path.isAbsolute(file) && fs.realpathSync(file) === file, 'canonical file required');
  const named = fs.lstatSync(file, { bigint: true });
  assert(named.isFile() && named.size <= BigInt(limit), 'bounded regular file required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert(same(named, before));
    const hash = createHash('sha256'), blocks = [], buffer = Buffer.alloc(1024 * 1024);
    let count = 0;
    while (count <= Number(before.size)) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - count), null);
      if (!n) break;
      count += n; assert(count <= Number(before.size), 'input grew');
      hash.update(buffer.subarray(0, n));
      if (collect) blocks.push(Buffer.from(buffer.subarray(0, n)));
    }
    assert(count === Number(before.size) && same(before, fs.fstatSync(fd, { bigint: true })) &&
      same(before, fs.lstatSync(file, { bigint: true })), 'input changed');
    return { sha256: hash.digest('hex'), bytes: count, ...(collect ? { data: Buffer.concat(blocks) } : {}) };
  } finally { fs.closeSync(fd); }
}

async function main() {
  const [manifestPath, manifestHash, output, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && SHA.test(manifestHash ?? '') && path.isAbsolute(output ?? ''),
    'usage: pinned-node build-companion.mjs ABS_INPUT_MANIFEST EXPECTED_SHA256 ABS_NEW_OUTPUT');
  assert(process.execPath === NODE && process.version === 'v26.8.1' && process.platform === 'darwin' && process.arch === 'arm64');
  assert.deepEqual(process.execArgv, [], 'no preload, loader or condition overrides');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH', 'AGENC_RUNTIME_ROOT', 'AGENC_BUILD_TIME'])
    assert(!process.env[key], 'ambient build override');
  assert(fs.realpathSync(CORE) === CORE && fs.realpathSync(HERE) === HERE);
  const canonicalOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  assert(output === canonicalOutput && !within(CORE, output) && !within(FAIR, output), 'separate canonical output required');
  assert(!fs.existsSync(output), 'never reuse output');
  phase = 'validate_manifest';
  const manifestBytes = inspect(manifestPath, true, 16 * 1024 * 1024);
  assert(manifestBytes.sha256 === manifestHash, 'preaccepted input manifest mismatch');
  // Root-authored trusted JSON, not model/request input or self-authorizing scan.
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes.data));
  assert(manifest.schemaVersion === 1 && manifest.productRevision === REVISION &&
    manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files));
  const files = Object.entries(manifest.files);
  assert(files.length > 0 && files.length <= 100000);
  for (const [file, hash] of files) {
    assert(SHA.test(hash) && (within(CORE, file) || within(FAIR, file) || file === NODE));
  }
  for (const [file, hash] of Object.entries(FIXED)) assert(manifest.files[file] === hash, 'required input pin absent or changed');
  const builder = fileURLToPath(import.meta.url);
  assert(manifest.files[builder] === inspect(builder).sha256, 'builder not preaccepted');
  function verifyInventory() {
    for (const [file, hash] of files) assert(inspect(file).sha256 === hash, 'pinned input changed');
  }
  phase = 'verify_inputs_before_build';
  verifyInventory();
  const version = JSON.parse(inspect(path.join(RUNTIME, 'dist/VERSION'), true).data);
  assert.deepEqual(version, { commit: REVISION, shortCommit: '403da04398b5',
    buildTime: '2026-09-30T09:07:17.000Z', runtimeVersion: '0.18.0' });
  phase = 'create_output';
  fs.mkdirSync(output, { mode: 0o700 });
  ownedOutput = output;
  const save = (name, value) => fs.writeFileSync(path.join(output, name),
    JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  save('selection.json', { recipeVersion: 3, revision: REVISION, version, manifestHash, builderSha256: inspect(builder).sha256,
    localBuildOnly: true, executionApproved: false, inputCount: files.length });
  phase = 'stage_exact_package_assets';
  const dist = path.join(output, 'dist');
  fs.mkdirSync(path.join(dist, 'yolo-classifier-prompts'), { recursive: true, mode: 0o700 });
  const packageAssets = [];
  for (const relative of ['package.json', 'dist/VERSION',
    'dist/yolo-classifier-prompts/auto_mode_system_prompt.txt',
    'dist/yolo-classifier-prompts/permissions_external.txt']) {
    const source = path.join(RUNTIME, relative), record = inspect(source, true, 16 * 1024 * 1024);
    assert(record.sha256 === manifest.files[source] && record.sha256 === FIXED[source], 'asset pin changed');
    fs.writeFileSync(path.join(output, relative), record.data, { flag: 'wx', mode: 0o600 });
    packageAssets.push({ source, destination: relative, bytes: record.bytes, sha256: record.sha256 });
  }

  phase = 'load_pinned_esbuild';
  const require = createRequire(path.join(RUNTIME, 'package.json'));
  const { build, transform, version: esbuildVersion } = require('esbuild');
  phase = 'transform_build_config';
  const transformed = await transform(inspect(path.join(RUNTIME, 'build.config.ts'), true).data.toString('utf8'),
    { format: 'esm', loader: 'ts', platform: 'node', target: 'node26', sourcefile: path.join(RUNTIME, 'build.config.ts') });
  const configPath = path.join(output, 'reviewed-build-config.mjs');
  fs.writeFileSync(configPath, transformed.code, { flag: 'wx', mode: 0o600 });
  process.env.AGENC_RUNTIME_ROOT = RUNTIME;
  process.env.AGENC_BUILD_TIME = version.buildTime;
  phase = 'load_build_config';
  const { default: config } = await import(pathToFileURL(configPath).href);
  assert.deepEqual(config.esbuildPlugins.map(plugin => plugin.name), ['agenc-feature-flag-inline',
    'agenc-bare-src-alias', 'agenc-optional-external', 'agenc-known-missing-optional-external', 'agenc-runtime-assets']);
  // These files must retain their original import.meta-relative runtime location.
  const preserved = new Set(['selection.mjs', 'compatibility-selection.mjs', 'empty-resources.mjs',
    'preflight-selection.mjs'].map(n => path.join(HERE, n)));
  preserved.add(path.join(FAIR, 'luna-observer-v6/direct.mjs'));
  const preserveLocations = { name: 'companion-original-locations', setup(context) {
    context.onResolve({ filter: /^\.{1,2}\// }, args => {
      const file = path.resolve(path.dirname(args.importer), args.path);
      return preserved.has(file) ? { path: file, external: true } : null;
    });
  } };
  const options = { absWorkingDir: RUNTIME, bundle: true, format: 'esm', platform: 'node', target: config.target,
    tsconfig: path.join(RUNTIME, 'tsconfig.bundle.json'),
    entryPoints: { 'owner-companion': path.join(HERE, 'owner-entry.ts'),
      'preflight-companion': path.join(HERE, 'preflight-entry.ts') },
    outdir: dist, entryNames: '[name]', chunkNames: '[name]-[hash]',
    outExtension: { '.js': '.mjs' }, splitting: true, sourcemap: true,
    metafile: true, write: false, logLevel: 'silent', banner: {}, loader: {},
    external: [...new Set(config.external.flatMap(item => [item, ...(item.endsWith('/*') ? [] : [item + '/*'])]))],
    plugins: [preserveLocations, ...config.esbuildPlugins.slice(0, -1)] };
  config.esbuildOptions(options);
  options.alias = { ...options.alias, 'agenc-selected': path.join(RUNTIME, 'src') };
  phase = 'bundle_owner';
  const result = await build(options);
  phase = 'validate_source_graph';
  const inputs = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    assert(!input.startsWith('<'), 'unexpected virtual source');
    const file = fs.realpathSync(path.resolve(RUNTIME, input));
    assert(manifest.files[file] && inspect(file).sha256 === manifest.files[file], 'unaccepted graph input');
    assert(!file.includes('/tests/') && !file.includes('/vitest/'), 'test-only graph input');
    inputs.push({ input, canonical: file, sha256: manifest.files[file] });
  }
  const singleton = path.join(RUNTIME, 'src/session/current-session.ts');
  assert(inputs.filter(row => row.canonical === singleton).length === 1, 'one canonical scoped-session module required');
  const emitted = new Map(Object.entries(result.metafile.outputs).map(([name, metadata]) =>
    [path.resolve(RUNTIME, name), metadata]));
  const singletonOutputs = [...emitted].filter(([, metadata]) => Object.entries(metadata.inputs).some(([name, detail]) =>
    fs.realpathSync(path.resolve(RUNTIME, name)) === singleton && detail.bytesInOutput > 0)).map(([name]) => name);
  assert(singletonOutputs.length === 1, 'scoped-session must contribute bytes to exactly one output');
  const entryOutputs = ['owner-companion.mjs', 'preflight-companion.mjs'].map(name => path.join(dist, name));
  assert(entryOutputs.every(name => emitted.has(name)), 'guarded entry output missing');
  // Static reachability, not merely source dynamic-import syntax: an optional
  // external hoisted into any eagerly linked shared chunk is still a blocker.
  const entryClosures = entryOutputs.map(entry => {
    const staticReachable = new Set(), pending = [entry];
    while (pending.length) {
      const name = pending.pop();
      if (staticReachable.has(name)) continue;
      staticReachable.add(name);
      const metadata = emitted.get(name);
      for (const [input, detail] of Object.entries(metadata.inputs)) {
        assert(detail.bytesInOutput === 0 || !within(path.join(RUNTIME, 'src'),
          fs.realpathSync(path.resolve(RUNTIME, input))), 'Core source became eager before selection');
      }
      for (const item of metadata.imports) {
        if (item.external || item.kind !== 'import-statement') continue;
        const target = path.resolve(RUNTIME, item.path);
        assert(emitted.has(target), 'unresolved emitted static edge');
        pending.push(target);
      }
    }
    return { entry, staticReachable };
  });
  const chromeStaticOutputs = [...emitted].filter(([, metadata]) => metadata.imports.some(item =>
    item.external && item.kind === 'import-statement' && item.path === '@ant/agenc-for-chrome-mcp')).map(([name]) => name);
  assert(chromeStaticOutputs.length > 0 && chromeStaticOutputs.every(name =>
    entryClosures.every(row => !row.staticReachable.has(name))),
    'optional Chrome import became eager');
  const splitGraph = { format: 'esm', splitting: true, layout: 'owned-package-root/flat-dist',
    entries: entryClosures.map(row => ({ entry: path.relative(output, row.entry),
      staticClosure: [...row.staticReachable].sort().map(name => path.relative(output, name)), coreSourceBytesAbsent: true })),
    scopedSessionOutputs: singletonOutputs.map(name => path.relative(output, name)),
    optionalChromeStaticOutputs: chromeStaticOutputs.map(name => path.relative(output, name)),
    optionalChromeOutsideBothEntryStaticClosures: true };
  for (const expected of ['src/app-server/daemon-cli.ts', 'src/session/session.ts', 'src/llm/providers/openai/adapter.ts'])
    assert(inputs.some(row => row.canonical === path.join(RUNTIME, expected)), 'required live graph absent');
  const externals = [...new Set(Object.values(result.metafile.outputs).flatMap(row =>
    row.imports.filter(item => item.external).map(item => item.path)))].sort();
  assert(!externals.some(name => name.startsWith('src/') || name.startsWith('agenc-selected/') || name.startsWith('bun:')),
    'unresolved source alias');
  // External packages remain actual pinned Core dependencies, never stubs.
  // The link is new output state only; the immutable target is not modified.
  phase = 'record_external_resolution';
  fs.symlinkSync(path.join(CORE, 'node_modules'), path.join(output, 'node_modules'), 'dir');
  const externalResolution = externals.map(specifier => {
    if (isBuiltin(specifier)) return { specifier, builtin: true };
    if (preserved.has(specifier)) return { specifier, canonical: specifier, sha256: manifest.files[specifier] };
    // Resolve-only CJS evidence. ESM conditional exports and nonliteral runtime
    // loads remain separate deployment gates; do not import packages here.
    try {
      const file = fs.realpathSync(require.resolve(specifier));
      assert(manifest.files[file] && inspect(file).sha256 === manifest.files[file], 'unaccepted external entry');
      return { specifier, requireCanonical: file, sha256: manifest.files[file] };
    } catch { return { specifier, unresolvedRequire: true }; }
  });
  phase = 'verify_inputs_after_build';
  verifyInventory();
  phase = 'publish_build_artifacts';
  const outputs = [];
  for (const file of result.outputFiles) {
    assert(path.dirname(file.path) === dist && path.normalize(file.path) === file.path, 'output escape');
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file.path, file.contents, { flag: 'wx', mode: 0o600 });
    outputs.push({ name: path.relative(output, file.path), bytes: file.contents.length, sha256: sha(file.contents) });
  }
  save('metafile.json', result.metafile);
  save('build-result.json', { schemaVersion: 1, recipeVersion: 3, revision: REVISION, manifestHash, esbuildVersion,
    inputs, outputs, packageAssets, splitGraph, externalResolution, plugins: options.plugins.map(plugin => plugin.name), defines: options.define,
    oneScopedSessionModule: true, artifactImported: false, executionApproved: false, deploymentClosureComplete: false,
    localDarwinDependenciesOnly: true,
    missingDeploymentPrerequisites: ['Linux Node/native package ABI and dependency closure',
      'Linux sandbox launcher graph and canonical host readiness', 'Linux process broker and Landlock helper',
      'memory query helper graph', 'ordinary sibling CLI graph',
      'canonical Linux peer-authentication/native storage inputs', 'observer/Python/selection Linux path closure'],
    limits: ['local source graph only; ESM external exports, dynamic/native/assets and full dependency closure unvalidated',
      'selection remains disabled; no preflight, callbacks, daemon, CLI, provider or Linux execution',
      'trusted immutable inputs; before/after hashes are not a concurrent adversarial-filesystem guarantee'] });
  console.log(JSON.stringify({ built: true, inputCount: inputs.length, outputCount: outputs.length,
    executionApproved: false, deploymentClosureComplete: false }));
}
main().catch(error => {
  // Private build diagnostics only: no stack, source snippets, environment,
  // assertion actual/expected values, or arbitrary thrown-object serialization.
  const assertion = error instanceof assert.AssertionError;
  const diagnostic = { schemaVersion: 1, status: 'failed', phase,
    code: typeof error?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code : null,
    message: assertion && error.generatedMessage === false && typeof error.message === 'string'
      ? error.message.slice(0, 512) : assertion ? 'assertion_failed' : 'build_operation_failed' };
  if (Array.isArray(error?.errors)) diagnostic.esbuildErrors = error.errors.slice(0, 8).map(item => ({
    message: typeof item?.text === 'string' ? item.text.slice(0, 1024) : 'esbuild_error',
    file: typeof item?.location?.file === 'string' ? item.location.file.slice(0, 1024) : null,
    line: Number.isSafeInteger(item?.location?.line) ? item.location.line : null,
    column: Number.isSafeInteger(item?.location?.column) ? item.location.column : null,
  }));
  const text = JSON.stringify(diagnostic) + '\n';
  if (ownedOutput !== null) {
    try { fs.writeFileSync(path.join(ownedOutput, 'build-failure.json'), text, { flag: 'wx', mode: 0o600 }); }
    catch { console.error('companion_build_failure_record_not_written'); }
  }
  console.error(text.trimEnd());
  process.exitCode = 1;
});
