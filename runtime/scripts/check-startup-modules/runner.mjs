/**
 * AgenC startup-modules gate.
 *
 * A cold one-shot `agenc -p` run should reach its first model request
 * without loading code it does not use there. Several startup cuts removed
 * whole packages from that path; this gate keeps them out. It runs one cold
 * one-shot against the local mock model with a module-load trace in the CLI
 * and in the daemon the CLI starts, then fails if a listed module loaded in
 * either process before the first chat request reached the mock.
 */
import { readFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMockProviderEnv, startMockModelServer } from "../local-openai-compatible-mock.mjs";
import {
  configureTuiGateSandbox,
  createTuiGateProject,
  createTuiGateState,
  installTuiGateSignalHandlers,
  teardownTuiGateState,
  writeTuiGateTrust,
} from "../tui-gate-state.mjs";
import { runOwnedOneShotProcess } from "../check-llm-pipeline/runner.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const TRACE_HOOK = path.join(SCRIPT_DIR, "trace-hook.mjs");

/** Modules a cold one-shot must not load before its first model request. */
export const FORBIDDEN_BEFORE_FIRST_REQUEST = Object.freeze([
  {
    pattern: /\/node_modules\/lodash-es\/lodash\.js$/,
    reason: "the lodash-es package entry re-exports every function (about 640 modules); import single functions",
  },
  {
    pattern: /\/node_modules\/axios\//,
    reason: "axios is needed only by HTTP hooks, session ingress and downloads",
  },
  {
    pattern: /\/node_modules\/@modelcontextprotocol\/sdk\//,
    reason: "the MCP SDK is needed only when an MCP server is connected or MCP traffic is handled",
  },
  {
    pattern: /\/node_modules\/ajv(?:-formats)?\//,
    reason: "Ajv is needed only when a schema is validated",
  },
]);

/** Parse one trace file written by trace-hook.mjs. */
export function parseStartupTrace(text) {
  const lines = text.split("\n");
  const header = lines[0]?.startsWith("# ") ? lines[0].slice(2) : "[]";
  const loads = [];
  for (const line of lines.slice(1)) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const time = Number(line.slice(0, space));
    if (!Number.isFinite(time)) continue;
    loads.push({ time, url: line.slice(space + 1) });
  }
  return { argv: header, loads };
}

/** Offending loads: a listed module loaded before the first request. */
export function findStartupOffenders(traces, firstRequestMs, rules = FORBIDDEN_BEFORE_FIRST_REQUEST) {
  const offenders = [];
  for (const trace of traces) {
    for (const load of trace.loads) {
      if (load.time >= firstRequestMs) continue;
      const rule = rules.find((candidate) => candidate.pattern.test(load.url));
      if (rule === undefined) continue;
      if (offenders.some((o) => o.argv === trace.argv && o.reason === rule.reason)) continue;
      offenders.push({ argv: trace.argv, url: load.url, reason: rule.reason });
    }
  }
  return offenders;
}

async function readTraces(directory) {
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".txt"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Promise.all(
    names.map(async (name) => parseStartupTrace(await readFile(path.join(directory, name), "utf8"))),
  );
}

async function main() {
  let mockServer;
  let gateState;
  let removeSignalHandlers = () => {};
  let cleanupPromise;
  let traceEnv;
  let projectDir;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      const failures = [];
      if (traceEnv !== undefined) {
        try {
          await runOwnedOneShotProcess({
            executable: process.execPath,
            args: [BIN_AGENC, "daemon", "stop"],
            cwd: projectDir,
            env: { ...traceEnv, NODE_OPTIONS: "" },
            timeoutMs: 30_000,
            label: "agenc daemon stop",
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (gateState !== undefined) {
        try {
          await teardownTuiGateState(gateState, BIN_AGENC);
        } catch (error) {
          failures.push(error);
        }
      }
      if (mockServer !== undefined) {
        try {
          await mockServer.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "startup-modules gate cleanup failed");
    })();
    return cleanupPromise;
  };

  let code = 2;
  let runError = null;
  try {
    mockServer = await startMockModelServer();
    gateState = await createTuiGateState({
      injectedEnv: buildMockProviderEnv(mockServer.baseUrl, {}),
      prefix: "agenc-startup-modules-gate-",
    });
    removeSignalHandlers = installTuiGateSignalHandlers(cleanup);
    projectDir = createTuiGateProject(gateState);
    await writeTuiGateTrust(gateState.env, [projectDir]);
    // Like the TUI gate: hosts without user namespaces (CI containers) cannot
    // run the required sandbox, and the listed packages do not depend on it.
    await configureTuiGateSandbox(gateState, BIN_AGENC, "danger-full-access");
    const traceDir = path.join(gateState.root, "startup-trace");
    // The gate isolates NODE_OPTIONS; set it only for this run, so the CLI
    // and the daemon it starts both load the trace hook.
    traceEnv = { ...gateState.env, NODE_OPTIONS: `--import=${pathToFileURL(TRACE_HOOK).href}`, AGENC_STARTUP_TRACE_DIR: traceDir };
    const result = await runOwnedOneShotProcess({
      executable: process.execPath,
      args: [BIN_AGENC, "-p", "Reply with the single word OK."],
      cwd: projectDir,
      env: traceEnv,
      timeoutMs: 120_000,
      label: "agenc -p (startup-modules gate)",
    });
    if (result.exitCode !== 0) {
      throw new Error(`agenc -p exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const firstRequestMs = mockServer.chatRequestTimes[0];
    if (firstRequestMs === undefined) throw new Error("the one-shot made no model request");
    const traces = await readTraces(traceDir);
    if (traces.length < 2) {
      throw new Error(`expected traces from the CLI and the daemon, found ${traces.length}`);
    }
    const offenders = findStartupOffenders(traces, firstRequestMs);
    if (offenders.length === 0) {
      console.log(`startup-modules gate passed: ${traces.length} processes, no listed module before the first request`);
      code = 0;
    } else {
      for (const offender of offenders) {
        console.error(`loaded before the first request in ${offender.argv}: ${offender.url}\n  ${offender.reason}`);
      }
      code = 1;
    }
  } catch (error) {
    runError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (runError === null) runError = error;
  } finally {
    removeSignalHandlers();
  }
  if (runError !== null) throw runError;
  return code;
}

function isEntrypoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === SCRIPT_PATH;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`startup-modules gate failed: ${error?.stack ?? error}`);
      process.exit(2);
    },
  );
}
