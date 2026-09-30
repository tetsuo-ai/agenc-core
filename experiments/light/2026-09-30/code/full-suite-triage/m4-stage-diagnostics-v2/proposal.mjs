// Pure source transformation proposal. Reads/writes/spawns NOTHING.
// Caller supplies exact pinned source text; returned strings are NOT applied.
import { createHash } from 'node:crypto';

export const PINS = Object.freeze({
  parent: '5023d5a8ab76b632e62669b41548a51cc0230840f914acc46671b403134f0162',
  child: 'bef9e37ef9535bfddac0cadda6275791f1813a9d8e1a31c384f1a086ecb19514',
  daemon: '348144aa9c597359fba0176d3c826c346ac48282953afa959a6be8739d1816ca',
});
const hash = text => createHash('sha256').update(text).digest('hex');
function replace(text, from, to, count = 1) {
  if (text.split(from).length !== count + 1) throw new Error('source anchor mismatch');
  return text.split(from).join(to);
}

export function proposedSources(input) {
  for (const key of Object.keys(PINS)) {
    if (typeof input[key] !== 'string' || hash(input[key]) !== PINS[key]) {
      throw new Error('source preimage mismatch');
    }
  }
  let { parent, child, daemon } = input;
  child = 'import { mark } from "./m4-stage-diagnostics.mjs";\n' + child;
  child = replace(child, 'const RUN_ID =', 'mark("fixture_entry");\n\nconst RUN_ID =');
  child = replace(child,
    'const paths = pathsFor(requireArgument(process.argv[4], "state directory"));',
    'const paths = pathsFor(requireArgument(process.argv[4], "state directory"));\nmark("paths_ready");');
  child = replace(child, '  await crash(failpoint, paths);',
    '  mark("crash_dispatch");\n  await crash(failpoint, paths);');
  child = replace(child,
    '  process.stdout.write(`${JSON.stringify(await recover(failpoint, paths))}\\n`);',
    '  mark("recover_start");\n  const report = await recover(failpoint, paths);\n  mark("recover_done");\n  process.stdout.write(`${JSON.stringify(report)}\\n`);');
  const start = child.indexOf('async function crashReservation(');
  const end = child.indexOf('\nasync function crashModel(', start);
  if (start < 0 || end < 0) throw new Error('reservation source span missing');
  let reservation = child.slice(start, end);
  reservation = replace(reservation, '  const [rollout,',
    '  mark("reservation_setup_start");\n  const [rollout,');
  reservation = replace(reservation, '  const kernel = new ExecutionAdmissionKernel(',
    '  mark("reservation_setup_ready");\n  const kernel = new ExecutionAdmissionKernel(');
  reservation = replace(reservation, '  const client = kernel.bindClient(',
    '  mark("kernel_ready");\n  const client = kernel.bindClient(');
  reservation = replace(reservation, '  await client.acquire(',
    '  mark("journal_bound");\n  mark("acquire_start");\n  await client.acquire(');
  child = child.slice(0, start) + reservation + child.slice(end);
  daemon = 'import { mark } from "./m4-stage-diagnostics.mjs";\n' + daemon;
  daemon = replace(daemon, 'try {\n', 'mark("daemon_entry");\ntry {\n  mark("main_start");\n');

  parent = 'import { createCollector, createLocalProbe, observeMarkerWait, observeSdkAttempt, emitDiagnostic } from "./fixtures/m4-stage-diagnostics.mjs";\n' + parent;
  parent = replace(parent, 'const FAILPOINT_TOKEN =',
    'const DIAGNOSTIC_PRELOAD = fileURLToPath(new URL("./fixtures/m4-stage-preload.mjs", import.meta.url));\n\nconst FAILPOINT_TOKEN =');
  parent = replace(parent, '  return env;\n',
    '  delete env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE;\n  return env;\n');
  parent = replace(parent, 'function collectChild(child: ChildProcess): Promise<ChildExit> {',
    'function collectChild(child: ChildProcess, scope: "crash" | "recover" | "daemon"): Promise<ChildExit> {\n' +
    '  const diagnostic = createCollector(scope);\n' +
    '  const channel = child.stdio[3];\n' +
    '  if (channel !== null && channel !== undefined && "on" in channel) {\n' +
    '    channel.on("data", (bytes: Buffer) => diagnostic.push(bytes));\n' +
    '    channel.on("error", () => diagnostic.push(null));\n' +
    '  }\n');
  parent = replace(parent, '      resolve({ code, signal, stdout, stderr });',
    '      emitDiagnostic(() => { diagnostic.end(); return diagnostic.report(); });\n' +
    '      resolve({ code, signal, stdout, stderr });');
  parent = replace(parent, '      "--import",\n      TSX_IMPORT,',
    '      "--import",\n      DIAGNOSTIC_PRELOAD,\n      "--import",\n      TSX_IMPORT,', 3);
  parent = replace(parent, 'stdio: ["ignore", "pipe", "pipe"]',
    'stdio: ["ignore", "pipe", "pipe", "pipe"]', 3);
  parent = replace(parent, '  env.AGENC_TEST_DURABILITY_FAILPOINT = failpoint;',
    '  env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE = "crash";\n  env.AGENC_TEST_DURABILITY_FAILPOINT = failpoint;');
  parent = replace(parent, '      env: cleanChildEnvironment(),',
    '      env: { ...cleanChildEnvironment(), AGENC_TEST_M4_DIAGNOSTIC_SCOPE: "recover" },');
  parent = replace(parent, '    AGENC_HOME: home,',
    '    AGENC_TEST_M4_DIAGNOSTIC_SCOPE: "daemon",\n    AGENC_HOME: home,');
  parent = replace(parent, 'const exitPromise = collectChild(child);',
    'const exitPromise = collectChild(child, "crash");\n  const markerDiagnostic = createLocalProbe("marker");');
  parent = replace(parent, '    await waitForMarker(marker, child);',
    '    try {\n      await observeMarkerWait(markerDiagnostic.emitter, () => waitForMarker(marker, child));\n' +
    '    } finally {\n      emitDiagnostic(() => markerDiagnostic.finish());\n    }');
  parent = replace(parent, 'const result = await collectChild(child);',
    'const result = await collectChild(child, "recover");');
  parent = replace(parent, 'const exit = collectChild(daemon);',
    'const exit = collectChild(daemon, "daemon");\n  const sdkDiagnostic = createLocalProbe("sdk");');
  parent = replace(parent, 'async function connectFreshDaemon(stateDirectory: string): Promise<{',
    'async function connectFreshDaemon(stateDirectory: string, sdkOrdinal: 1 | 2): Promise<{');
  parent = replace(parent, 'const first = await connectFreshDaemon(stateDirectory);',
    'const first = await connectFreshDaemon(stateDirectory, 1);');
  parent = replace(parent, 'const second = await connectFreshDaemon(stateDirectory);',
    'const second = await connectFreshDaemon(stateDirectory, 2);');
  parent = replace(parent, '      client = await connect({',
    '      client = await observeSdkAttempt(sdkDiagnostic.emitter, () => connect({');
  parent = replace(parent, '        clientId: `m4-sdk-${process.pid}`,\n      });',
    '        clientId: `m4-sdk-${process.pid}`,\n      }));');
  parent = replace(parent, '  if (client === undefined) {',
    '  emitDiagnostic(() => ({ sdkOrdinal, ...sdkDiagnostic.finish() }));\n  if (client === undefined) {');
  return { parent, child, daemon };
}
