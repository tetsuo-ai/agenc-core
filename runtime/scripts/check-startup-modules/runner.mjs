/**
 * AgenC startup-modules gate.
 *
 * A cold one-shot `agenc -p` run should reach its first model request
 * without loading code it does not use there. Several startup cuts removed
 * whole packages from that path; this gate keeps them out. It runs one cold
 * one-shot against the local mock model with a module-load trace in the CLI
 * and in its daemon, then fails if a listed module loaded in either process
 * before the first chat request reached the mock.
 *
 * Like the pipeline gate, it starts the daemon itself as a retained child, so
 * cleanup can stop the one-shot and the daemon on any exit path, signals
 * included. The CLI imports its daemon autostart code statically, so its
 * module graph is the same whether it starts a daemon or finds one running.
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
  startTuiGateDaemon,
  teardownTuiGateState,
  writeTuiGateTrust,
} from "../tui-gate-state.mjs";
import {
  createPipelineGateLifecycle,
  runOwnedOneShotProcess,
  terminateActiveOneShots,
} from "../check-llm-pipeline/runner.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const TRACE_HOOK = path.join(SCRIPT_DIR, "trace-hook.mjs");

/** Modules a cold one-shot must not load before its first model request. */
export const FORBIDDEN_BEFORE_FIRST_REQUEST = Object.freeze([
  {
    pattern: /^bundled:.*\/src\/services\/compact\/(?:compact|transaction|prompt)\.ts$/,
    reason: "compaction transaction code loads only when compaction is attempted",
  },
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
  {
    pattern: /\/node_modules\/undici\/(?:index\.js$|lib\/(?:mock\/|web\/websocket\/|web\/fetch\/index\.js$))/,
    reason: "the first request needs Undici dispatchers, not its full fetch, mock or WebSocket entrypoints",
  },
  {
    pattern: /^bundled:.*\/node_modules\/zod\//,
    reason: "Zod must use the installed package instance rather than a second bundled copy",
  },
  {
    pattern: /\/node_modules\/(?:diff|tar|vscode-jsonrpc|chokidar|readdirp|js-yaml)\//,
    reason: "diffs, archive extraction, LSP connections, settings watches and YAML parsing load their packages on first use",
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

/** Inspect the sources in loaded dist chunks, whose hashed URLs hide packages. */
export async function addBundledStartupSources(traces, firstRequestMs, distDirectory) {
  const root = path.resolve(distDirectory) + path.sep;
  const maps = new Map();
  return Promise.all(traces.map(async (trace) => {
    const loads = [...trace.loads];
    for (const load of trace.loads) {
      if (load.time >= firstRequestMs || !load.url.startsWith("file:")) continue;
      const filename = fileURLToPath(load.url);
      if (!filename.startsWith(root) || !filename.endsWith(".js")) continue;
      let sources = maps.get(filename);
      if (sources === undefined) {
        // Missing or malformed maps must fail the gate, not hide a regression.
        sources = readFile(`${filename}.map`, "utf8").then((text) => {
          const map = JSON.parse(text);
          if (!Array.isArray(map.sources) || map.sources.some((source) => typeof source !== "string")) {
            throw new Error(`invalid sources in ${filename}.map`);
          }
          return map.sources;
        });
        maps.set(filename, sources);
      }
      for (const source of await sources) {
        loads.push({ time: load.time, url: `bundled:${source.replaceAll("\\", "/")}`, chunk: load.url });
      }
    }
    return { ...trace, loads };
  }));
}

/** The `--import` option that loads the trace hook, writing into `directory`. */
export function traceImportOption(directory) {
  const url = pathToFileURL(TRACE_HOOK);
  url.searchParams.set("dir", directory);
  return `--import=${url.href}`;
}

async function readTraces(directory) {
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => /^\d+\.txt$/.test(name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Promise.all(
    names.map(async (name) => ({
      pid: Number(name.slice(0, -".txt".length)),
      ...parseStartupTrace(await readFile(path.join(directory, name), "utf8")),
    })),
  );
}

/**
 * Run the gate. `binAgenc` is the CLI entry to test; it defaults to this
 * checkout's build. Returns 0 (pass) or 1 (a listed module loaded early).
 */
export async function runStartupModulesGate({ binAgenc = BIN_AGENC } = {}) {
  const lifecycle = createPipelineGateLifecycle();
  let mockServer;
  let gateState;
  let gateStatePromise;
  let removeSignalHandlers = () => {};
  let cleanupPromise;
  const cleanup = () => {
    lifecycle.beginCleanup();
    cleanupPromise ??= (async () => {
      let state = gateState;
      if (state === undefined && gateStatePromise !== undefined) {
        try {
          state = await gateStatePromise;
        } catch {
          // State creation failed before publishing an owned root.
        }
      }
      const failures = [];
      // The one-shot first, then the daemon it talks to and the state.
      try {
        await terminateActiveOneShots();
      } catch (error) {
        failures.push(error);
      }
      if (state !== undefined) {
        try {
          await teardownTuiGateState(state, binAgenc);
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
    gateStatePromise = createTuiGateState({
      injectedEnv: buildMockProviderEnv(mockServer.baseUrl, {}),
      prefix: "agenc-startup-modules-gate-",
    });
    removeSignalHandlers = installTuiGateSignalHandlers(cleanup);
    gateState = await gateStatePromise;
    lifecycle.assertOpen();
    const projectDir = createTuiGateProject(gateState);
    await writeTuiGateTrust(gateState.env, [projectDir]);
    // Like the TUI gate: hosts without user namespaces (CI containers) cannot
    // run the required sandbox, and the listed packages do not depend on it.
    await configureTuiGateSandbox(gateState, binAgenc, "danger-full-access");
    lifecycle.assertOpen();
    const traceDir = path.join(gateState.root, "startup-trace");
    const traceImport = traceImportOption(traceDir);
    const daemonPid = await startTuiGateDaemon(gateState, binAgenc, { nodeArgs: [traceImport] });
    // The gate env keeps NODE_OPTIONS empty; only this one-shot gets the hook.
    const result = await runOwnedOneShotProcess({
      executable: process.execPath,
      args: [binAgenc, "-p", "Reply with the single word OK."],
      cwd: projectDir,
      env: { ...gateState.env, NODE_OPTIONS: traceImport },
      timeoutMs: 120_000,
      label: "agenc -p (startup-modules gate)",
      lifecycle,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `agenc -p exited ${result.exitCode ?? result.signal}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const firstRequestMs = mockServer.chatRequestTimes[0];
    if (firstRequestMs === undefined) throw new Error("the one-shot made no model request");
    const traces = await readTraces(traceDir);
    if (!traces.some((trace) => trace.pid === daemonPid)) {
      throw new Error(`no module trace from the gate's daemon (pid ${daemonPid})`);
    }
    if (!traces.some((trace) => trace.pid !== daemonPid && trace.argv.includes('"-p"'))) {
      throw new Error("no module trace from the one-shot");
    }
    const mappedTraces = await addBundledStartupSources(
      traces, firstRequestMs, path.resolve(path.dirname(binAgenc), ".."),
    );
    const offenders = findStartupOffenders(mappedTraces, firstRequestMs);
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

  let cleanupError = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  } finally {
    removeSignalHandlers();
  }
  if (runError !== null && cleanupError !== null) {
    throw new AggregateError([runError, cleanupError], "startup-modules gate and its cleanup both failed");
  }
  if (runError !== null) throw runError;
  if (cleanupError !== null) throw cleanupError;
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
  // Exit codes are set, not forced, so a signal handler's code wins.
  runStartupModulesGate().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`startup-modules gate failed: ${error?.stack ?? error}`);
      process.exitCode = 2;
    },
  );
}
