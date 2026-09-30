// Build only. Never imports emitted entries, starts clients, installs packages,
// or activates selections. Inputs/map hashes must be accepted by the owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = '/gate/source', RUNTIME = CORE + '/runtime';
const PRODUCT = '403da04398b55e51d1f4e8814f9a70957b0db5ef';
const BUILD = '38d63e586a92c4da8b1e51b31d46f74ee359a55a';
const OLD_SOURCE = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/';
const SHA = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => file === root || file.startsWith(root + '/');
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
let phase = 'arguments', ownedOutput;

// Bounded read, including a byte beyond initial size to detect growth; never
// follows a final symlink. Trusted immutable ancestors remain a precondition.
function inspect(file, collect = false, limit = 256 * 1024 * 1024) {
  assert(path.isAbsolute(file) && fs.realpathSync(file) === file, 'canonical input required');
  const named = fs.lstatSync(file, { bigint: true });
  assert(named.isFile() && named.size <= BigInt(limit), 'bounded regular input required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert(same(named, before), 'input identity changed');
    const hash = createHash('sha256'), blocks = [], buffer = Buffer.alloc(1024 * 1024);
    let count = 0;
    while (count <= Number(before.size)) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - count), null);
      if (!n) break;
      count += n;
      assert(count <= Number(before.size), 'input grew');
      hash.update(buffer.subarray(0, n));
      if (collect) blocks.push(Buffer.from(buffer.subarray(0, n)));
    }
    assert(count === Number(before.size) && same(before, fs.fstatSync(fd, { bigint: true })) &&
      same(before, fs.lstatSync(file, { bigint: true })), 'input changed');
    return { sha256: hash.digest('hex'), bytes: count, mode: Number(before.mode) & 0o777,
      ...(collect ? { data: Buffer.concat(blocks) } : {}) };
  } finally { fs.closeSync(fd); }
}
function acceptedJson(file, hash) {
  assert(SHA.test(hash ?? ''), 'expected digest required');
  const bytes = inspect(file, true, 32 * 1024 * 1024);
  assert(bytes.sha256 === hash, 'preaccepted JSON mismatch');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.data));
}

async function main() {
  const [manifestPath, manifestHash, mapPath, mapHash, output, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && path.isAbsolute(output ?? ''), 'expected manifest/hash map/hash new-output');
  assert(process.platform === 'linux' && process.arch === 'x64' && process.version === 'v26.5.0', 'selected Linux Node required');
  assert.deepEqual(process.execArgv, [], 'no preload or condition override');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ESBUILD_BINARY_PATH', 'AGENC_RUNTIME_ROOT'])
    assert(!process.env[key], 'ambient build override');
  phase = 'manifest';
  const manifest = acceptedJson(manifestPath, manifestHash), map = acceptedJson(mapPath, mapHash);
  assert(manifest.schemaVersion === 1 && manifest.productRevision === PRODUCT && manifest.buildRevision === BUILD,
    'source/build selection mismatch');
  assert(map.schemaVersion === 1 && map.coreRoot === CORE && path.isAbsolute(map.fairRoot) && path.isAbsolute(map.runRoot), 'build map invalid');
  const FAIR = map.fairRoot, HERE = FAIR + '/current-cli-observer-v1';
  assert(fs.realpathSync(CORE) === CORE && fs.realpathSync(FAIR) === FAIR &&
    fs.realpathSync(map.runRoot) === map.runRoot, 'canonical roots required');
  assert(!within(CORE, map.runRoot) && !within(FAIR, map.runRoot), 'run root overlaps inputs');
  assert(output === path.join(fs.realpathSync(path.dirname(output)), path.basename(output)) &&
    within(map.runRoot, output) && output !== map.runRoot && !fs.existsSync(output), 'fresh owned output required');
  assert(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'file inventory required');
  const files = Object.entries(manifest.files), node = fs.realpathSync(process.execPath);
  assert(files.length > 0 && files.length <= 100000, 'inventory count out of bounds');
  for (const [file, hash] of files) assert(SHA.test(hash) &&
    (within(CORE, file) || within(FAIR, file) || within(map.runRoot, file) || file === node), 'inventory path or digest invalid');
  const fixed = {
    [CORE + '/package-lock.json']: 'a6d4ca9885fc8fea507135919a7677b682b629b5a3887b4dcb665a058e8ddd94',
    [RUNTIME + '/build.config.ts']: 'b34f5c7fa761269447aa645385380c883574b436fcb096b45c398d872c702558',
    [RUNTIME + '/scripts/build-runtime.mjs']: 'c2b64c66c44abf13b6203237b6d1341ac5f70b80686089959c47bef11b956aec',
    [RUNTIME + '/tsconfig.bundle.json']: 'ae3c771a0aff86f224b5acc5ab1e83d732fb27af736d21ea613298bc000c14bc',
    [RUNTIME + '/src/build/feature.ts']: 'ac2e0d25f8f5af58f32ec2ea339aabc720b07f5ff9754691573a46ec40438ed9',
    [HERE + '/owner-caller.ts']: 'f7bab3b8297f0bbdae0418dbc451da178741f47ce0f2924c9369f6888011bff0',
    [HERE + '/owner-entry.ts']: '680231dce925644253f02a561f0b5020f13a7b4bb1aebdcd61419f917e8eaef1',
    [HERE + '/companion-validator.ts']: '95c96544107846974dd9663796354b82cd592ad4b75c25df5f750ccea912a27b',
    [HERE + '/fixture-callbacks.ts']: '40e03b818ed202b7ce6f8bd6f8f88dd4ef607d7f5c0c3b87bccf79fd2ce49d82',
    [HERE + '/preflight-entry.ts']: 'cce66cfcd3c2bb0fb3049b93f9f46cc5371f4d71b866d6bc0ac6f0cd687b5c97',
    [HERE + '/preflight.ts']: 'fad448e9bff8199ab5881669558a8fc6651f5d96ed69e929c1506059bd69df4f',
    [HERE + '/selection.mjs']: 'd3ede932b460525dccc1f15eef01a13aee6ec2030d30dadc068c81244cb3a0f6',
    [HERE + '/preflight-selection.mjs']: '4213db8e45d9f65b940d32f5000c2debcb7d472e1ba9945addffde87d4384d9c',
    [HERE + '/compatibility-selection.mjs']: '4d64a68689ec07db0a92bf1a73358c406953bff7d2285ad47ad258c3931d6d77',
    [HERE + '/empty-resources.mjs']: '48dcec5348328bc0e4507f83cf3a4b6b21df935f69d2c8da3af5aef34fd4a972',
    [FAIR + '/real-parent-adapters-v2/bridge-entry.ts']: '168cb09d13b15d5ad2eeb83ebe5aedb452d1eba16ac3296fd7ae62519d18cefb',
    [FAIR + '/luna-observer-v6/direct.mjs']: '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
  };
  for (const [file, hash] of Object.entries(fixed)) assert(manifest.files[file] === hash, 'fixed source pin mismatch');
  const builder = fileURLToPath(import.meta.url);
  for (const file of [builder, mapPath, node, RUNTIME + '/package.json', RUNTIME + '/dist/VERSION',
    CORE + '/node_modules/esbuild/lib/main.js', CORE + '/node_modules/esbuild/package.json',
    CORE + '/node_modules/@esbuild/linux-x64/bin/esbuild']) assert(manifest.files[file], 'required input absent');
  assert(manifest.files[mapPath] === mapHash, 'map not bound by manifest');
  const redirects = {
    [HERE + '/selection.mjs']: map.runRoot + '/selection/owner-selection.mjs',
    [HERE + '/preflight-selection.mjs']: map.runRoot + '/selection/preflight-selection.mjs',
    [FAIR + '/real-parent-adapters-v2/pins.mjs']: map.runRoot + '/identity/pins.mjs',
  };
  assert.deepEqual(map.externalRedirects, redirects, 'only reviewed external redirects allowed');
  assert.deepEqual(map.sourcePrefixRedirect, { from: OLD_SOURCE, to: RUNTIME + '/src/' }, 'source redirect mismatch');
  const ownerSelection = redirects[HERE + '/selection.mjs'];
  assert(!fs.existsSync(ownerSelection) && !manifest.files[ownerSelection], 'owner selection must await closed preflight');
  for (const target of Object.values(redirects).filter(file => file !== ownerSelection))
    assert(manifest.files[target], 'overlay pin absent');
  const verify = () => { for (const [file, hash] of files) assert(inspect(file).sha256 === hash, 'input pin changed'); };
  phase = 'verify_before'; verify();
  const version = JSON.parse(inspect(RUNTIME + '/dist/VERSION', true).data);
  assert(version.commit === BUILD && version.shortCommit === BUILD.slice(0, 12) && version.runtimeVersion === '0.18.0', 'canonical build identity mismatch');
  assert(typeof version.buildTime === 'string' && Number.isFinite(Date.parse(version.buildTime)), 'build timestamp invalid');
  phase = 'create_output';
  fs.mkdirSync(output, { mode: 0o700 }); ownedOutput = output;
  const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  save('selection.json', { schemaVersion: 1, productRevision: PRODUCT, buildRevision: BUILD,
    manifestHash, mapHash, builderSha256: manifest.files[builder], executionApproved: false });

  // Preserve the completed canonical Linux build, including CLI, sandbox graph,
  // memory helper, prompts and native helper binaries. No asset plugin/compile.
  phase = 'stage_canonical_runtime';
  const assets = [];
  function copyFile(source, relative) {
    const record = inspect(source, true);
    assert(record.sha256 === manifest.files[source], 'canonical asset not accepted');
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, record.data, { flag: 'wx', mode: record.mode });
    fs.chmodSync(target, record.mode);
    assets.push({ source, destination: relative, sha256: record.sha256, bytes: record.bytes, mode: record.mode });
  }
  function copyTree(relative) {
    const source = path.join(RUNTIME, relative);
    assert(fs.realpathSync(source) === source && fs.lstatSync(source).isDirectory(), 'canonical asset directory required');
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) copyTree(child);
      else { assert(entry.isFile(), 'unsupported canonical asset type'); copyFile(path.join(RUNTIME, child), child); }
    }
  }
  copyFile(RUNTIME + '/package.json', 'package.json'); copyTree('dist'); copyTree('bin');
  for (const name of ['dist/agenc-process-broker', 'dist/agenc-landlock-run', 'dist/agenc-secret-service-helper']) {
    const bytes = inspect(path.join(output, name), true).data;
    assert(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      (fs.statSync(path.join(output, name)).mode & 0o111), 'canonical Linux helper unavailable');
  }
  for (const name of ['bin/agenc', 'bin/agenc-linux-sandbox', 'dist/sandbox/linux-launcher/main.js',
    'dist/memory/memory-query-helper.js', 'dist/yolo-classifier-prompts/auto_mode_system_prompt.txt',
    'dist/yolo-classifier-prompts/permissions_external.txt']) assert(assets.some(row => row.destination === name), 'required runtime asset absent');
  fs.symlinkSync(CORE + '/node_modules', output + '/node_modules', 'dir');

  phase = 'load_esbuild';
  const require = createRequire(RUNTIME + '/package.json');
  const { build, transform, version: esbuildVersion } = require('esbuild');
  const transformed = await transform(inspect(RUNTIME + '/build.config.ts', true).data.toString('utf8'),
    { format: 'esm', loader: 'ts', platform: 'node', target: 'node26', sourcefile: RUNTIME + '/build.config.ts' });
  const configPath = output + '/reviewed-build-config.mjs';
  fs.writeFileSync(configPath, transformed.code, { flag: 'wx', mode: 0o600 });
  process.env.AGENC_RUNTIME_ROOT = RUNTIME; process.env.AGENC_BUILD_TIME = version.buildTime;
  const { default: config } = await import(pathToFileURL(configPath).href);
  assert.deepEqual(config.esbuildPlugins.map(p => p.name), ['agenc-feature-flag-inline', 'agenc-bare-src-alias',
    'agenc-optional-external', 'agenc-known-missing-optional-external', 'agenc-runtime-assets']);
  const preserved = new Set([HERE + '/compatibility-selection.mjs', HERE + '/empty-resources.mjs',
    FAIR + '/luna-observer-v6/direct.mjs', ...Object.values(redirects)]);
  const locations = { name: 'reviewed-linux-locations', setup(context) {
    context.onResolve({ filter: /^(?:\.{1,2}\/|\/private\/tmp\/light-clean-cli-validator-v2-GANyA9\/)/ }, args => {
      if (args.path.startsWith(OLD_SOURCE)) return context.resolve(RUNTIME + '/src/' + args.path.slice(OLD_SOURCE.length),
        { resolveDir: RUNTIME, kind: args.kind });
      const file = path.resolve(path.dirname(args.importer), args.path);
      if (redirects[file]) return { path: redirects[file], external: true };
      return preserved.has(file) ? { path: file, external: true } : null;
    });
  } };
  const dist = output + '/dist';
  const options = { absWorkingDir: RUNTIME, bundle: true, format: 'esm', platform: 'node', target: config.target,
    tsconfig: RUNTIME + '/tsconfig.bundle.json', entryPoints: {
      'owner-caller': HERE + '/owner-caller.ts', 'preflight-companion': HERE + '/preflight-entry.ts',
      'identity-bridge': FAIR + '/real-parent-adapters-v2/bridge-entry.ts',
    }, outdir: dist, entryNames: '[name]', chunkNames: 'companion-[name]-[hash]',
    outExtension: { '.js': '.mjs' }, splitting: true, sourcemap: true, metafile: true,
    write: false, logLevel: 'silent', banner: {}, loader: {},
    external: [...new Set(config.external.flatMap(item => [item, ...(item.endsWith('/*') ? [] : [item + '/*'])]))],
    plugins: [locations, ...config.esbuildPlugins.slice(0, -1)] };
  config.esbuildOptions(options);
  options.alias = { ...options.alias, 'agenc-selected': RUNTIME + '/src' };
  phase = 'bundle'; const result = await build(options);
  phase = 'validate_graph';
  const inputs = Object.keys(result.metafile.inputs).map(input => {
    assert(!input.startsWith('<'), 'virtual source forbidden');
    const canonical = fs.realpathSync(path.resolve(RUNTIME, input));
    assert(manifest.files[canonical] && inspect(canonical).sha256 === manifest.files[canonical], 'unaccepted graph source');
    assert(!canonical.includes('/tests/') && !canonical.includes('/vitest/'), 'test graph forbidden');
    return { input, canonical, sha256: manifest.files[canonical] };
  });
  const singleton = RUNTIME + '/src/session/current-session.ts';
  assert(inputs.filter(row => row.canonical === singleton).length === 1, 'one canonical scoped-session input required');
  const emitted = new Map(Object.entries(result.metafile.outputs).map(([name, metadata]) => [path.resolve(RUNTIME, name), metadata]));
  const singletonOutputs = [...emitted].filter(([, m]) => Object.entries(m.inputs).some(([name, info]) =>
    fs.realpathSync(path.resolve(RUNTIME, name)) === singleton && info.bytesInOutput > 0)).map(([name]) => name);
  assert(singletonOutputs.length === 1, 'one emitted scoped-session chunk required');
  const entries = { owner: 'dist/owner-caller.mjs', preflight: 'dist/preflight-companion.mjs', bridge: 'dist/identity-bridge.mjs' };
  assert(Object.values(entries).every(name => emitted.has(output + '/' + name)), 'entry missing');
  const closures = [entries.owner, entries.preflight].map(entry => {
    const seen = new Set(), pending = [output + '/' + entry];
    while (pending.length) {
      const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
      const metadata = emitted.get(file); assert(metadata, 'unresolved static edge');
      for (const [input, info] of Object.entries(metadata.inputs)) assert(info.bytesInOutput === 0 ||
        !within(RUNTIME + '/src', fs.realpathSync(path.resolve(RUNTIME, input))), 'Core source eager before gate');
      for (const edge of metadata.imports) if (!edge.external && edge.kind === 'import-statement') pending.push(path.resolve(RUNTIME, edge.path));
    }
    return { entry, staticClosure: [...seen].map(file => path.relative(output, file)), coreSourceBytesAbsent: true };
  });
  const chromeOutputs = [...emitted].filter(([, m]) => m.imports.some(edge => edge.external &&
    edge.kind === 'import-statement' && edge.path === '@ant/agenc-for-chrome-mcp')).map(([file]) => path.relative(output, file));
  assert(chromeOutputs.every(file => closures.every(row => !row.staticClosure.includes(file))), 'optional Chrome eager');
  for (const relative of ['src/app-server/daemon-cli.ts', 'src/session/session.ts', 'src/llm/providers/openai/adapter.ts'])
    assert(inputs.some(row => row.canonical === RUNTIME + '/' + relative), 'live source graph absent');
  const externals = [...new Set([...emitted.values()].flatMap(m => m.imports.filter(e => e.external).map(e => e.path)))].sort();
  assert(!externals.some(name => /^(src\/|agenc-selected\/|bun:|\/private\/)/.test(name)), 'unresolved or Darwin external');
  const externalResolution = externals.map(specifier => {
    if (isBuiltin(specifier)) return { specifier, builtin: true };
    if (specifier === ownerSelection) return { specifier, deferredOwnerSelection: true, absentAtBuild: true };
    if (preserved.has(specifier)) { assert(manifest.files[specifier], 'external pin missing'); return { specifier, sha256: manifest.files[specifier] }; }
    let file;
    try { file = fs.realpathSync(require.resolve(specifier)); }
    catch { return { specifier, unresolvedRequire: true }; }
    assert(manifest.files[file] && inspect(file).sha256 === manifest.files[file], 'unaccepted external entry');
    return { specifier, requireCanonical: file, sha256: manifest.files[file] };
  });
  phase = 'verify_after'; verify();
  assert(!fs.existsSync(ownerSelection), 'owner selection appeared during build');
  phase = 'publish';
  const outputs = result.outputFiles.map(file => {
    assert(path.dirname(file.path) === dist && !fs.existsSync(file.path), 'output collision or escape');
    fs.writeFileSync(file.path, file.contents, { flag: 'wx', mode: 0o600 });
    return { name: path.relative(output, file.path), bytes: file.contents.length, sha256: sha(file.contents) };
  });
  save('metafile.json', result.metafile);
  save('build-result.json', { schemaVersion: 1, productRevision: PRODUCT, buildRevision: BUILD, version,
    manifestHash, mapHash, entries, esbuildVersion, node: process.version, inputs, outputs, packageAssets: assets,
    splitGraph: { splitting: true, layout: 'canonical-runtime-plus-flat-companion-chunks', guardedEntries: closures,
      scopedSessionOutputs: singletonOutputs.map(file => path.relative(output, file)), chromeOutputs,
      bridgeRole: 'trusted parent control API; statically links canonical Core control modules' },
    externalResolution, plugins: options.plugins.map(p => p.name), defines: options.define,
    artifactImported: false, executionApproved: false, deploymentClosureComplete: false,
    limits: ['no runtime/preflight/daemon/CLI/provider execution',
      'canonical Linux assets copied; host sandbox/ABI/authenticated identity not yet exercised',
      'dependency link requires retained accepted /gate/source tree; not a relocatable package',
      'ESM conditions and dynamic observer/Python closure remain owner deployment obligations',
      'one ALS applies to the companion graph; copied ordinary CLI runs separately',
      'trusted immutable preaccepted manifest; no adversarial concurrent-filesystem guarantee'] });
  console.log(JSON.stringify({ built: true, inputCount: inputs.length, outputCount: outputs.length,
    canonicalAssetCount: assets.length, entries, executionApproved: false }));
}
main().catch(error => {
  const assertion = error instanceof assert.AssertionError;
  const diagnostic = { schemaVersion: 1, status: 'failed', phase,
    message: assertion && error.generatedMessage === false ? error.message.slice(0, 512) : 'linux_companion_build_failed' };
  if (Array.isArray(error?.errors)) diagnostic.esbuildErrors = error.errors.slice(0, 8).map(e => ({
    message: typeof e?.text === 'string' ? e.text.slice(0, 1024) : 'esbuild_error',
    file: typeof e?.location?.file === 'string' ? e.location.file.slice(0, 1024) : null,
    line: Number.isSafeInteger(e?.location?.line) ? e.location.line : null,
  }));
  const text = JSON.stringify(diagnostic) + '\n';
  if (ownedOutput) { try { fs.writeFileSync(ownedOutput + '/build-failure.json', text, { flag: 'wx', mode: 0o600 }); }
    catch { console.error('linux_companion_failure_record_not_written'); } }
  console.error(text.trimEnd()); process.exitCode = 1;
});
