/**
 * AgenC TUI E2E gate runner.
 *
 * Discovers scenarios under `./scenarios`, runs each in turn, captures
 * failures, dumps full PTY output to `/tmp/tui-e2e-failure-<scenario>.log`
 * on failure, and exits non-zero if any scenario failed.
 *
 * Scenarios run serially within one runner. Each scenario owns a private
 * HOME/AGENC_HOME, daemon, ephemeral WebSocket endpoint, and temp tree, so
 * independent filtered runners can be sharded safely.
 */
import { realpathSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TuiSession, tuiE2eGateEnv } from "./harness.mjs";
import {
  MOCK_MODEL,
  buildMockProviderEnv,
  startMockModelServer,
} from "../local-openai-compatible-mock.mjs";
import {
  configureTuiGateSandbox,
  createTuiGateProject,
  createTuiGateState,
  environmentForTuiGateState,
  installTuiGateSignalHandlers,
  startTuiGateDaemon,
  teardownTuiGateState,
} from "../tui-gate-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(SCRIPT_DIR, "scenarios");
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const DEFAULT_TIMEOUT_MS = 60_000;
const ABORT_QUIESCE_MS = 10_000;
export function replaceProcessEnvironment(nextEnv) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, nextEnv);
}

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function color(c, s) {
  return process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s;
}

async function discoverScenarios() {
  const entries = await readdir(SCENARIOS_DIR);
  return entries
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

async function loadScenario(name) {
  const fileUrl = pathToFileURL(path.join(SCENARIOS_DIR, name)).href;
  const mod = await import(fileUrl);
  if (typeof mod.default !== "function") {
    throw new Error(`scenario ${name} must export a default async function`);
  }
  return {
    name,
    meta: mod.meta ?? {},
    run: mod.default,
  };
}

function applyScenarioFilters(names, argv) {
  let filtered = names;
  const filterIndex = argv.findIndex((a) => a === "--filter");
  if (filterIndex >= 0 && argv[filterIndex + 1] !== undefined) {
    const needle = argv[filterIndex + 1];
    filtered = filtered.filter((n) => n.includes(needle));
  }
  const rangeIndex = argv.findIndex((a) => a === "--range");
  if (rangeIndex >= 0 && argv[rangeIndex + 1] !== undefined) {
    const [lo, hi] = argv[rangeIndex + 1].split("-").map((s) => Number.parseInt(s, 10));
    filtered = filtered.filter((n) => {
      const m = /^(\d+)-/.exec(n);
      if (!m) return false;
      const num = Number.parseInt(m[1], 10);
      return num >= lo && num <= hi;
    });
  }
  return filtered;
}

function createScenarioSession(scenario, scenarioCwd, gateState) {
  return new TuiSession({
    args: scenario.meta.args ?? [],
    gateState,
    ...(scenario.meta.sandboxMode
      ? { sandboxMode: scenario.meta.sandboxMode }
      : {}),
    ...(scenario.meta.env ? { env: scenario.meta.env } : {}),
    ...(scenario.meta.cwd
      ? { cwd: scenario.meta.cwd }
      : { cwd: scenarioCwd }),
  });
}

function createScenarioTimeout(timeoutMs) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({
        kind: "timeout",
        error: new Error(`scenario timeout after ${timeoutMs}ms`),
      }),
      timeoutMs,
    );
  });
  return {
    promise,
    clear: () => clearTimeout(timer),
  };
}

function combineErrors(primary, cleanup, message) {
  if (primary && cleanup) return new AggregateError([primary, cleanup], message);
  return primary ?? cleanup ?? null;
}

function waitForScenarioQuiescence(scenarioSettled) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ kind: "unquiesced" }),
      ABORT_QUIESCE_MS,
    );
    scenarioSettled.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

export async function runScenario(scenario, gateState, lifecycle = null) {
  const startedAt = Date.now();
  // Every scenario gets a small private git fixture. This keeps project
  // discovery fast, makes git-oriented slash commands realistic, and makes
  // filtered runners safe to shard against the same source checkout.
  const scenarioCwd = createTuiGateProject(gateState, {
    dirty: scenario.meta.dirtyCwd === true,
  });
  const session = createScenarioSession(scenario, scenarioCwd, gateState);
  if (lifecycle !== null) lifecycle.activeSession = session;
  const debug = process.env.TUI_E2E_DEBUG === "1";
  const timeoutMs = scenario.meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = createScenarioTimeout(timeoutMs);
  const scenarioSettled = Promise.resolve()
    .then(() => scenario.run(session))
    .then(
      () => ({ kind: "settled", error: null }),
      (error) => ({ kind: "settled", error }),
    );
  let scenarioError = null;
  let quiesced = true;
  try {
    const outcome = await Promise.race([scenarioSettled, timeout.promise]);
    if (outcome.kind === "timeout") {
      scenarioError = outcome.error;
      await session.abort(outcome.error);
      const quiescence = await waitForScenarioQuiescence(scenarioSettled);
      quiesced = quiescence.kind === "settled";
    } else {
      scenarioError = outcome.error;
    }
    if (scenarioError === null) session.assertNoCrash();
  } catch (error) {
    scenarioError = error;
  } finally {
    timeout.clear();
  }
  let cleanupError = null;
  try {
    await session.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (lifecycle?.activeSession === session) lifecycle.activeSession = null;
  const error = combineErrors(
    scenarioError,
    cleanupError,
    `scenario ${scenario.name} and its cleanup both failed`,
  );
  return {
    ok: error === null,
    quiesced,
    session,
    durationMs: Date.now() - startedAt,
    ...(error === null ? {} : { error }),
    capturedOutput: error === null && !debug ? undefined : session.raw,
  };
}

async function dumpFailureLog(scenario, result) {
  const logPath =
    `/tmp/tui-e2e-failure-${process.pid}-${scenario.name.replace(/\.mjs$/, "")}.log`;
  const header = [
    `# TUI E2E failure: ${scenario.name}`,
    `# Description: ${scenario.meta.description ?? "(none)"}`,
    `# Duration: ${result.durationMs}ms`,
    `# Error: ${result.error?.message ?? String(result.error)}`,
    "",
    "## Captured PTY output (raw)",
    "",
  ].join("\n");
  await writeFile(logPath, header + (result.capturedOutput ?? ""), "utf8");
  return logPath;
}

async function startMockedGate() {
  const mockServer = await startMockModelServer();
  return {
    mockServer,
    injectedEnv: tuiE2eGateEnv(
      buildMockProviderEnv(mockServer.baseUrl, {}),
    ),
  };
}

function printGateHeader(names, mockServer) {
  console.log(
    color("bold", `agenc TUI e2e gate (${names.length} scenarios)`),
  );
  console.log(
    color("dim", `  model: openai-compatible:${MOCK_MODEL} (${mockServer.baseUrl})`),
  );
  console.log(color("dim", "  state: private HOME/AGENC_HOME + ephemeral daemon per scenario"));
  console.log("");
}

function recordPreflightFailure(state, name, error) {
  console.log(`${color("red", "FAIL")} ${color("dim", `(${error.message})`)}`);
  state.failed.push({ name, error, logPath: null });
}

async function recordScenarioResult(state, scenario, result) {
  if (result.ok) {
    state.passed += 1;
    console.log(`${color("green", "PASS")} ${color("dim", `(${result.durationMs}ms)`)}`);
    if (process.env.TUI_E2E_DEBUG === "1" && result.capturedOutput) {
      const logPath =
        `/tmp/tui-e2e-pass-${process.pid}-${scenario.name.replace(/\.mjs$/, "")}.log`;
      await writeFile(logPath, result.capturedOutput, "utf8");
      console.log(`      ${color("dim", `debug log: ${logPath}`)}`);
    }
    return;
  }

  const logPath = await dumpFailureLog(scenario, result);
  console.log(`${color("red", "FAIL")} ${color("dim", `(${result.durationMs}ms)`)}`);
  console.log(`      ${color("red", "✗")} ${result.error?.message ?? String(result.error)}`);
  console.log(`      ${color("dim", `log: ${logPath}`)}`);
  state.failed.push({ name: scenario.name, error: result.error, logPath });
}

async function runScenarioEntry(
  name,
  state,
  gateBaseEnv,
  gateInjectedEnv,
  lifecycle,
) {
  const originalEnv = { ...process.env };
  const gateStatePromise = createTuiGateState({
    baseEnv: gateBaseEnv,
    injectedEnv: gateInjectedEnv,
    prefix: `agenc-tui-e2e-${name.replace(/\.mjs$/u, "")}-`,
  });
  lifecycle.pendingGateState = gateStatePromise;
  const gateState = await gateStatePromise;
  if (lifecycle.pendingGateState === gateStatePromise) {
    lifecycle.pendingGateState = null;
  }
  lifecycle.activeGateState = gateState;
  let scenario = null;
  let result = null;
  replaceProcessEnvironment(gateState.env);
  try {
    if (lifecycle.interrupted) {
      throw new Error("TUI E2E gate interrupted before scenario startup");
    }
    scenario = await loadScenario(name);
    process.stdout.write(`  ${color("dim", "→")} ${name} … `);
    if (scenario.meta.skip) {
      console.log(`${color("yellow", "SKIP")} ${color("dim", `(${scenario.meta.skip})`)}`);
      state.skipped.push({ name, reason: scenario.meta.skip });
    } else {
      gateState.env = environmentForTuiGateState(
        gateState,
        scenario.meta.env ?? {},
      );
      replaceProcessEnvironment(gateState.env);
      await configureTuiGateSandbox(
        gateState,
        BIN_AGENC,
        scenario.meta.sandboxMode,
      );
      if (lifecycle.interrupted) {
        throw new Error("TUI E2E gate interrupted before daemon startup");
      }
      await startTuiGateDaemon(gateState, BIN_AGENC);
      if (lifecycle.interrupted) {
        throw new Error("TUI E2E gate interrupted before scenario execution");
      }
      result = await runScenario(scenario, gateState, lifecycle);
    }
  } catch (error) {
    result = {
      ok: false,
      durationMs: 0,
      error,
      capturedOutput: "",
    };
  } finally {
    let cleanupError = null;
    try {
      await teardownTuiGateState(gateState, BIN_AGENC);
    } catch (error) {
      cleanupError = error;
    }
    if (result?.quiesced !== false) {
      replaceProcessEnvironment(originalEnv);
    }
    if (lifecycle.activeGateState === gateState) {
      lifecycle.activeGateState = null;
    }
    if (cleanupError !== null) {
      if (result === null) {
        result = {
          ok: false,
          durationMs: 0,
          error: cleanupError,
          capturedOutput: "",
        };
      } else {
        result = {
          ...result,
          ok: false,
          error: combineErrors(
            result.ok ? null : result.error,
            cleanupError,
            `scenario ${name} and private-state cleanup both failed`,
          ),
        };
      }
    }
  }
  if (result?.quiesced === false) {
    const error = new Error(
      `scenario ${name} did not quiesce after cancellation; terminating runner`,
    );
    error.fatalIsolationFailure = true;
    throw error;
  }
  if (scenario === null) {
    recordPreflightFailure(state, name, result.error);
    return;
  }
  if (scenario.meta.skip && result === null) return;
  await recordScenarioResult(state, scenario, result);
}

function printSummary(state) {
  console.log("");
  const totalRan = state.passed + state.failed.length;
  const skipNote = state.skipped.length > 0 ? `, ${state.skipped.length} skipped` : "";
  if (state.failed.length === 0) {
    console.log(
      color("green", `✓ ${state.passed}/${totalRan} passed${skipNote}`),
    );
    if (state.skipped.length > 0) {
      for (const s of state.skipped) {
        console.log(`    ${color("yellow", "skip")} ${s.name}: ${s.reason}`);
      }
    }
    return 0;
  }
  console.log(
    color(
      "red",
      `✗ ${state.failed.length}/${totalRan} failed (${state.passed} passed${skipNote})`,
    ),
  );
  for (const f of state.failed) {
    console.log(`    - ${f.name}: ${f.error?.message ?? String(f.error)}`);
  }
  return 1;
}

async function main() {
  const gateBaseEnv = { ...process.env };
  const { mockServer, injectedEnv } = await startMockedGate();
  const lifecycle = {
    activeGateState: null,
    activeSession: null,
    interrupted: false,
    mockClosePromise: null,
    pendingGateState: null,
  };
  const closeMock = async () => {
    if (lifecycle.mockClosePromise === null) {
      lifecycle.mockClosePromise = mockServer.close();
    }
    await lifecycle.mockClosePromise;
  };
  const uninstallSignalHandlers = installTuiGateSignalHandlers(async () => {
    lifecycle.interrupted = true;
    const errors = [];
    if (lifecycle.activeSession !== null) {
      try {
        await lifecycle.activeSession.abort(new Error("TUI gate interrupted"));
        await lifecycle.activeSession.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (lifecycle.activeGateState !== null) {
      try {
        await teardownTuiGateState(lifecycle.activeGateState, BIN_AGENC);
      } catch (error) {
        errors.push(error);
      }
    } else if (lifecycle.pendingGateState !== null) {
      try {
        const pendingState = await lifecycle.pendingGateState;
        lifecycle.activeGateState = pendingState;
        await teardownTuiGateState(pendingState, BIN_AGENC);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await closeMock();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "TUI E2E signal cleanup failed");
    }
  });
  try {
    const names = applyScenarioFilters(await discoverScenarios(), process.argv.slice(2));
    if (names.length === 0) {
      console.error(color("red", "no scenarios matched the requested selection"));
      return 1;
    }
    printGateHeader(names, mockServer);
    const state = { failed: [], skipped: [], passed: 0 };
    for (const name of names) {
      if (lifecycle.interrupted) return 1;
      await runScenarioEntry(
        name,
        state,
        gateBaseEnv,
        injectedEnv,
        lifecycle,
      );
      if (lifecycle.interrupted) return 1;
    }
    return printSummary(state);
  } finally {
    try {
      await closeMock();
    } finally {
      uninstallSignalHandlers();
    }
  }
}

function isEntrypoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(color("red", `runner crashed: ${error?.stack ?? error}`));
      if (error?.fatalIsolationFailure === true) {
        process.exit(2);
      }
      process.exitCode = 2;
    });
}
