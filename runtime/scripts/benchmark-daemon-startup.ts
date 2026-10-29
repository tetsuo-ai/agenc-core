import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { seedDaemonStartupHome } from "./fixtures/daemon-startup-home.js";
import { createRedProbeMarkdownLoadHook } from "../tests/helpers/red-probe-markdown-loader.mjs";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "bun:bundle") return { url: new URL("../src/build/feature.ts", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}, load: createRedProbeMarkdownLoadHook({
  runtimeSourceRootUrl: new URL("../src/", import.meta.url).href,
  onAssetLoaded() {},
}) });

// Set both homes before importing runtime modules. No user data or credentials.
const root = mkdtempSync(join(tmpdir(), "agenc-ready-bench-"));
const bytes = process.env.BENCH_BYTES;
const readyBudgetMs = Number(process.env.BENCH_READY_BUDGET_MS ?? 1_000);
process.env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  HOME: join(root, "home"),
  AGENC_HOME: join(root, "agenc"),
  AGENC_DAEMON_WEBSOCKET_PORT: "0",
};
const fixture = seedDaemonStartupHome(root, {
  ...(bytes ? { bytes: Number(bytes) } : {}),
});
console.log(`fixture ${root}`);
process.chdir(fixture.workspaces[0]!);
const { runAgenCDaemonCli, AgenCDaemonSnapshotPolicyRegistry } = await import("../src/app-server/daemon-cli.js");
const { createAgenCJsonLineDaemonRequestClient } = await import("../src/app-server/agent-cli.js");
const { resolveAgenCDaemonCookiePath, resolveAgenCDaemonSocketPath } = await import("../src/app-server/daemon-control.js");
const { ExecutionAdmissionKernel } = await import("../src/budget/execution-admission-kernel.js");
const { resolveAgentRuntimeOptions } = await import("../src/session/runtime-options.js");
const phases: Record<string, number> = {};
for (const [prototype, key, label] of [
  [AgenCDaemonSnapshotPolicyRegistry.prototype, "hydrateStartupRecovery", "snapshotHydrationMs"],
  [AgenCDaemonSnapshotPolicyRegistry.prototype, "registerStartupRecovery", "snapshotRegistrationMs"],
  [AgenCDaemonSnapshotPolicyRegistry.prototype, "hydrateStartupRun", "snapshotHydrationMs"],
  [ExecutionAdmissionKernel.prototype, "initializeExistingState", "admissionRecoveryMs"],
] as const) {
  const target = prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = target[key]!;
  if (typeof original !== "function") continue;
  target[key] = function (...args: unknown[]) {
    const start = performance.now();
    try { return original.apply(this, args); }
    finally { phases[label] = (phases[label] ?? 0) + performance.now() - start; }
  };
}
const signalProcess = new EventEmitter();
let ready!: () => void;
const readyPromise = new Promise<void>(resolve => { ready = resolve; });
const log: string[] = [];
const started = performance.now();
const host = {
  env: process.env, userHome: fixture.userHome, pid: process.pid,
  execPath: process.execPath, entrypointPath: process.argv[1]!,
  isPidRunning: () => false,
  readProcessIdentity: (pid: number) => `benchmark:${pid}`,
  spawnDetachedDaemon: () => { throw new Error("benchmark must stay foreground"); },
  terminatePid: () => { throw new Error("benchmark must never signal a process"); },
  sleep: delay,
  readCurrentRuntimeBuild: () => null,
};
const running = runAgenCDaemonCli({ kind: "command", action: "run" }, {
  host, signalProcess,
  io: {
    stdout: { write: (chunk: string | Uint8Array) => { if (String(chunk).includes("daemon running")) ready(); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { log.push(String(chunk)); process.stderr.write(chunk); return true; } },
  },
  runner: { startAgent: async () => ({ agentId: "benchmark-new", startedAt: new Date().toISOString(), status: "running" }) },
});
await Promise.race([readyPromise, running.then(code => { throw new Error(`daemon exited ${code}: ${log.join("")}`); })]);
const readyMs = performance.now() - started;
console.log(`ready ${readyMs}ms`);
const client = createAgenCJsonLineDaemonRequestClient({
  socketPath: resolveAgenCDaemonSocketPath(host.env, host.userHome),
  authCookie: readFileSync(resolveAgenCDaemonCookiePath(host.env, host.userHome), "utf8").trim(),
  timeoutMs: 120_000,
});
const healthStarted = performance.now();
const health = await client.request("health.ready", {});
const healthMs = performance.now() - healthStarted;
console.log(`health ${healthMs}ms ${JSON.stringify(health)}`);
const createStarted = performance.now();
const created = await client.request("agent.create", { objective: "new session during restoration", cwd: fixture.workspaces[0], runtimeOptions: resolveAgentRuntimeOptions({}) });
const createMs = performance.now() - createStarted;
console.log(`create ${createMs}ms`);
// Idle sessions must stay cold even after a new session has been created.
// This guard catches eager snapshot replay without relying on host timing.
if (phases.snapshotHydrationMs !== undefined ||
    (await client.request("health.ready", {})).restoringSessions !== fixture.sessions) {
  throw new Error("daemon hydrated saved sessions before they were requested");
}
const coldRss = process.memoryUsage().rss;
if (readyMs > readyBudgetMs) throw new Error(`daemon readiness ${readyMs}ms exceeds ${readyBudgetMs}ms`);
const restoreStarted = performance.now();
await client.request("session.attach", { sessionId: "startup-0-0", clientId: "benchmark-resume" });
const restoreMs = performance.now() - restoreStarted;
console.log(`one requested restore ${restoreMs}ms`);
signalProcess.emit("SIGTERM");
const exitCode = await running;
const result = { root, fixture, readyMs, healthMs, createMs, restoreMs, coldRss, health, createdAgent: created.agentId, phases, exitCode };
writeFileSync(join(root, "timing.json"), JSON.stringify(result, null, 2) + "\n");
writeFileSync(join(root, "daemon.log"), log.join(""));
console.log(JSON.stringify(result, null, 2));
