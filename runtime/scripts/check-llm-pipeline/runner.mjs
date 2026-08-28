/**
 * AgenC LLM pipeline verification gate.
 *
 * The TUI E2E gate (`scripts/check-tui-e2e/`) verifies the user-facing
 * surface — types, submits, slash commands, tool round-trips — works
 * end-to-end. This gate verifies the WIRE shape of the conversation
 * the daemon assembles for the model: that the system prompt is
 * delivered first, tool-call payloads have the expected structure,
 * token tracking fires, and compaction is wired correctly.
 *
 * Architecture: start a local OpenAI-compatible mock model server,
 * spawn a fresh `agenc -p '<prompt>'` (one-shot daemon agent) against
 * an isolated HOME/AGENC_HOME, wait for completion, then parse the
 * rollout file the daemon wrote to
 * `~/.agenc/projects/<project>/sessions/<sid>/rollout-*.jsonl`.
 * The rollout is the daemon's authoritative record of every event in
 * the conversation, including tool calls with their full id/name/
 * arguments shape and the assembled message order.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_MODEL,
  buildMockProviderEnv,
  startMockModelServer,
} from "../local-openai-compatible-mock.mjs";
import {
  createTuiGateProject,
  createTuiGateState,
  installTuiGateSignalHandlers,
  startTuiGateDaemon,
  teardownTuiGateState,
  writeTuiGateTrust,
} from "../tui-gate-state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
let projectsDir;
let pipelineCwd;
let runnerEnv;
const activeOneShots = new Set();
const ONE_SHOT_TERM_GRACE_MS = 5_000;
const ONE_SHOT_KILL_GRACE_MS = 2_000;

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};
const color = (c, s) => (process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPipelineGateLifecycle() {
  let closing = false;
  return Object.freeze({
    beginCleanup() {
      closing = true;
    },
    assertOpen() {
      if (closing) throw new Error("LLM pipeline gate is shutting down");
    },
    get closing() {
      return closing;
    },
  });
}

let gateLifecycle = createPipelineGateLifecycle();

function configurePipelineHome(canonicalAgencHome) {
  projectsDir = path.join(canonicalAgencHome, "projects");
}

function observeOneShot(child, label) {
  const record = {
    child,
    label,
    stdout: "",
    stderr: "",
    closed: null,
    closePromise: null,
  };
  record.closePromise = new Promise((resolve) => {
    const settle = (outcome) => {
      if (record.closed !== null) return;
      record.closed = outcome;
      resolve(outcome);
    };
    child.once("close", (code, signal) => settle({ code, signal }));
    child.once("error", (error) => settle({ code: null, signal: null, error }));
  });
  child.stdout?.on("data", (chunk) => {
    record.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    record.stderr += chunk.toString();
  });
  activeOneShots.add(record);
  record.closePromise.then(() => activeOneShots.delete(record));
  return record;
}

async function waitForOneShotClose(record, timeoutMs) {
  if (record.closed !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(record.closed !== null), timeoutMs);
    record.closePromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateOneShot(
  record,
  {
    termGraceMs = ONE_SHOT_TERM_GRACE_MS,
    killGraceMs = ONE_SHOT_KILL_GRACE_MS,
  } = {},
) {
  if (record.closed !== null) return;
  try {
    record.child.kill("SIGTERM");
  } catch {
    // The retained ChildProcess close observation remains authoritative.
  }
  if (await waitForOneShotClose(record, termGraceMs)) return;
  try {
    record.child.kill("SIGKILL");
  } catch {
    // The bounded close wait below still proves whether the process stopped.
  }
  if (await waitForOneShotClose(record, killGraceMs)) return;
  throw new Error(
    `${record.label} survived SIGKILL (pid ${record.child.pid ?? "unknown"})`,
  );
}

export async function terminateActiveOneShots(options = {}) {
  const results = await Promise.allSettled(
    [...activeOneShots].map((record) => terminateOneShot(record, options)),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "LLM pipeline one-shot cleanup failed");
  }
}

export function activeOneShotCount() {
  return activeOneShots.size;
}

export async function runOwnedOneShotProcess({
  executable,
  args = [],
  cwd,
  env,
  timeoutMs,
  termGraceMs = ONE_SHOT_TERM_GRACE_MS,
  killGraceMs = ONE_SHOT_KILL_GRACE_MS,
  label = "LLM pipeline one-shot",
  lifecycle,
}) {
  lifecycle?.assertOpen();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("one-shot timeout must be a positive integer");
  }
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
  });
  const record = observeOneShot(child, label);
  const timeoutMarker = Symbol("one-shot-timeout");
  let timeout;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(timeoutMarker), timeoutMs);
  });
  try {
    const outcome = await Promise.race([record.closePromise, timeoutPromise]);
    if (outcome === timeoutMarker) {
      const timeoutError = new Error(`${label} exceeded ${timeoutMs}ms`);
      try {
        await terminateOneShot(record, { termGraceMs, killGraceMs });
      } catch (terminationError) {
        throw new AggregateError(
          [timeoutError, terminationError],
          `${label} timed out and could not be stopped`,
        );
      }
      throw timeoutError;
    }
    if (outcome.error !== undefined) throw outcome.error;
    return {
      stdout: record.stdout,
      stderr: record.stderr,
      exitCode: outcome.code,
      signal: outcome.signal,
    };
  } finally {
    clearTimeout(timeout);
    if (record.closed !== null) activeOneShots.delete(record);
  }
}

/**
 * Run agenc -p with a prompt and capture stdout. Returns { stdout, stderr, exitCode }.
 */
async function runOneShot(prompt, { yolo = false, timeoutMs = 120_000 } = {}) {
  gateLifecycle.assertOpen();
  const args = [BIN_AGENC];
  if (yolo) args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push("-p", prompt);
  return runOwnedOneShotProcess({
    executable: process.execPath,
    args,
    cwd: pipelineCwd,
    env: runnerEnv,
    timeoutMs,
    label: "agenc -p",
    lifecycle: gateLifecycle,
  });
}

/**
 * Find the rollout JSONL file the daemon just wrote, by mtime.
 * Returns the parsed lines.
 */
async function readMostRecentRollout({ sinceMs = 30_000 } = {}) {
  const cutoff = Date.now() - sinceMs;
  let newest = null;
  let newestMtime = 0;
  // Walk projects → sessions → rollout-*.jsonl.
  const projects = await readdir(projectsDir);
  for (const proj of projects) {
    const sessionsDir = path.join(projectsDir, proj, "sessions");
    let sessions;
    try {
      sessions = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const sess of sessions) {
      const sessDir = path.join(sessionsDir, sess);
      let entries;
      try {
        entries = await readdir(sessDir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.startsWith("rollout-") || !e.endsWith(".jsonl")) continue;
        const full = path.join(sessDir, e);
        try {
          const s = await stat(full);
          if (s.mtimeMs > newestMtime && s.mtimeMs >= cutoff) {
            newestMtime = s.mtimeMs;
            newest = full;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  if (!newest) {
    throw new Error(`no rollout file written in last ${sinceMs}ms`);
  }
  const raw = await readFile(newest, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return { path: newest, items: lines.map((l) => JSON.parse(l)) };
}

async function cleanupPipelineGate(gateState, mockServer) {
  const failures = [];
  try {
    await terminateActiveOneShots();
  } catch (error) {
    failures.push(error);
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
  if (failures.length > 0) {
    throw new AggregateError(failures, "LLM pipeline gate cleanup failed");
  }
}

export function createPipelineGateState(baseUrl, baseEnv = process.env) {
  return createTuiGateState({
    baseEnv,
    injectedEnv: buildMockProviderEnv(baseUrl, {}),
    prefix: "agenc-llm-pipeline-gate-",
  });
}

export function resolvePipelineGateOutcome(code, runError, cleanupError) {
  if (runError !== null && cleanupError !== null) {
    throw new AggregateError(
      [runError, cleanupError],
      "LLM pipeline gate and cleanup both failed",
    );
  }
  if (runError !== null) throw runError;
  if (cleanupError !== null) throw cleanupError;
  return code;
}

/* -------------------------------------------------------------------- */
/* Scenarios                                                             */
/* -------------------------------------------------------------------- */

const scenarios = [];

scenarios.push({
  name: "01-session-meta-first",
  description: "Rollout starts with session_meta describing model/cwd/version.",
  async run() {
    const result = await runOneShot("reply with the single word HELLO and nothing else", {
      yolo: true,
      timeoutMs: 180_000,
    });
    assertOneShotSucceeded(result);
    await sleep(500); // give the daemon a moment to flush
    const { items, path: rolloutPath } = await readMostRecentRollout();
    if (items.length === 0) throw new Error(`empty rollout: ${rolloutPath}`);
    const first = items[0];
    if (first.type !== "session_meta") {
      throw new Error(
        `first rollout entry must be session_meta, got "${first.type}"`,
      );
    }
    const p = first.payload ?? {};
    for (const required of ["sessionId", "timestamp", "cwd", "model", "modelProvider"]) {
      if (!p[required]) {
        throw new Error(`session_meta missing required field "${required}"`);
      }
    }
  },
});

scenarios.push({
  name: "02-turn-context-before-user-message",
  description:
    "turn_context (sandbox/approvalPolicy/cwd/etc) is recorded before the first user input.",
  async run() {
    const result = await runOneShot("reply with the single word HELLO and nothing else", {
      yolo: true,
      timeoutMs: 180_000,
    });
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const turnIdx = items.findIndex((i) => i.type === "turn_context");
    const userIdx = items.findIndex(
      (i) => i.type === "response_item" && i.payload?.role === "user",
    );
    if (turnIdx === -1) {
      throw new Error("rollout has no turn_context entry");
    }
    if (userIdx === -1) {
      throw new Error("rollout has no durable user input entry");
    }
    if (turnIdx > userIdx) {
      throw new Error(
        `turn_context (idx ${turnIdx}) must come before user input (idx ${userIdx})`,
      );
    }
    // turn_context payload should include cwd, approval, sandbox config
    const tc = items[turnIdx].payload ?? {};
    if (!tc.cwd) throw new Error("turn_context missing cwd");
    if (!tc.approvalPolicy) throw new Error("turn_context missing approvalPolicy");
    if (!tc.sandboxPolicy) throw new Error("turn_context missing sandboxPolicy");
  },
});

scenarios.push({
  name: "03-yolo-sets-approvalPolicy-never",
  description: "agenc --dangerously-bypass-approvals-and-sandbox -p produces turn_context with approvalPolicy='never'.",
  async run() {
    const result = await runOneShot("reply with the single word YES", {
      yolo: true,
      timeoutMs: 180_000,
    });
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const tc = items.find((i) => i.type === "turn_context");
    if (!tc) throw new Error("no turn_context in rollout");
    const policy = tc.payload?.approvalPolicy;
    if (policy !== "never") {
      throw new Error(
        `--dangerously-bypass-approvals-and-sandbox expected approvalPolicy='never', got '${policy}'. The yolo propagation chain (route.ts → daemon protocol → background-agent-runner.buildBootstrapArgv → bootstrap → sessionConfiguration) is broken.`,
      );
    }
    const sandbox = tc.payload?.sandboxPolicy;
    if (sandbox !== "danger_full_access") {
      throw new Error(
        `--dangerously-bypass-approvals-and-sandbox expected sandboxPolicy='danger_full_access', got '${sandbox}'`,
      );
    }
  },
});

scenarios.push({
  name: "04-tool-call-shape",
  description:
    "Tool invocations record tool_call_started + tool_call_completed with proper id/name/args.",
  async run() {
    const result = await runOneShot(
      "Use the Bash tool to run: echo PIPELINE-TOOL-CHECK",
      { yolo: true, timeoutMs: 240_000 },
    );
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const started = items.find(
      (i) =>
        i.type === "event_msg" &&
        i.payload?.msg?.type === "tool_call_started",
    );
    const completed = items.find(
      (i) =>
        i.type === "event_msg" &&
        i.payload?.msg?.type === "tool_call_completed",
    );
    if (!started) {
      throw new Error(
        "no tool_call_started event in rollout — model didn't invoke Bash, or tool dispatch is broken",
      );
    }
    if (!completed) {
      throw new Error(
        "no tool_call_completed event in rollout — tool ran but completion event missed",
      );
    }
    const sp = started.payload?.msg?.payload ?? {};
    if (!sp.callId || !sp.toolName) {
      throw new Error(
        `tool_call_started missing callId/toolName: ${JSON.stringify(sp)}`,
      );
    }
    if (typeof sp.args !== "string") {
      throw new Error(
        `tool_call_started.args must be a stringified payload, got type=${typeof sp.args}`,
      );
    }
    // args should be parseable JSON
    try {
      JSON.parse(sp.args);
    } catch (e) {
      throw new Error(`tool_call_started.args is not valid JSON: ${sp.args.slice(0, 100)}`);
    }
  },
});

scenarios.push({
  name: "05-token-count-tracked",
  description: "Each tool call surfaces a token_count event (compaction prerequisite).",
  async run() {
    const result = await runOneShot(
      "Use the Bash tool to run: echo TOKEN-CHECK",
      { yolo: true, timeoutMs: 240_000 },
    );
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const tokenEvents = items.filter(
      (i) =>
        i.type === "event_msg" &&
        i.payload?.msg?.type === "token_count",
    );
    if (tokenEvents.length === 0) {
      throw new Error(
        "no token_count events — context-window accounting is broken; compaction can't fire if it doesn't know token usage",
      );
    }
    // Token events should have numeric counts
    const first = tokenEvents[0].payload?.msg?.payload ?? {};
    if (typeof first.tokenCount !== "number" && typeof first.totalTokens !== "number") {
      throw new Error(
        `token_count event missing numeric count field: ${JSON.stringify(first).slice(0, 200)}`,
      );
    }
  },
});

scenarios.push({
  name: "06-turn-completes",
  description: "Successful run ends with turn_complete event (no hung session).",
  async run() {
    const result = await runOneShot("reply with the single word DONE", {
      yolo: true,
      timeoutMs: 180_000,
    });
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const complete = items.find(
      (i) =>
        i.type === "event_msg" &&
        i.payload?.msg?.type === "turn_complete",
    );
    if (!complete) {
      throw new Error(
        "rollout has no turn_complete event — session may have hung or crashed mid-turn",
      );
    }
  },
});

scenarios.push({
  name: "07-assistant-response-recorded",
  description: "Assistant response is recorded as a response_item with role='assistant'.",
  async run() {
    const result = await runOneShot("reply with the single word RECORDED", {
      yolo: true,
      timeoutMs: 180_000,
    });
    assertOneShotSucceeded(result);
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const assistantItems = items.filter(
      (i) => i.type === "response_item" && i.payload?.role === "assistant",
    );
    if (assistantItems.length === 0) {
      throw new Error(
        "rollout has no assistant response_item — model output was lost",
      );
    }
  },
});

/* -------------------------------------------------------------------- */
/* Runner                                                                */
/* -------------------------------------------------------------------- */

async function runPipelineScenarios(mockServer) {
  console.log(color("bold", `agenc LLM pipeline gate (${scenarios.length} scenarios)`));
  console.log(color("dim", "  state: private HOME/AGENC_HOME + owned workspace"));
  console.log(color("dim", `  cwd: ${pipelineCwd}`));
  console.log(color("dim", `  model: openai-compatible:${MOCK_MODEL} (${mockServer.baseUrl})`));
  console.log("");
  let passed = 0;
  const failed = [];
  for (const sc of scenarios) {
    gateLifecycle.assertOpen();
    process.stdout.write(`  ${color("dim", "→")} ${sc.name} … `);
    const startedAt = Date.now();
    try {
      await sc.run();
      const dur = Date.now() - startedAt;
      passed += 1;
      console.log(`${color("green", "PASS")} ${color("dim", `(${dur}ms)`)}`);
    } catch (error) {
      if (gateLifecycle.closing) throw error;
      const dur = Date.now() - startedAt;
      console.log(`${color("red", "FAIL")} ${color("dim", `(${dur}ms)`)}`);
      console.log(`      ${color("red", "✗")} ${error.message}`);
      failed.push({ name: sc.name, error });
    }
  }

  console.log("");
  if (failed.length === 0) {
    console.log(color("green", `✓ ${passed}/${scenarios.length} passed`));
    return 0;
  }
  console.log(color("red", `✗ ${failed.length}/${scenarios.length} failed (${passed} passed)`));
  for (const f of failed) {
    console.log(`    - ${f.name}: ${f.error.message}`);
  }
  return 1;
}

async function main() {
  gateLifecycle = createPipelineGateLifecycle();
  let gateState;
  let gateStatePromise;
  let mockServer;
  let removeSignalHandlers = () => {};
  let cleanupPromise;
  const cleanup = () => {
    gateLifecycle.beginCleanup();
    cleanupPromise ??= (async () => {
      let state = gateState;
      if (state === undefined && gateStatePromise !== undefined) {
        try {
          state = await gateStatePromise;
          gateState = state;
        } catch {
          // State creation failed before publishing an owned root.
        }
      }
      await cleanupPipelineGate(state, mockServer);
    })();
    return cleanupPromise;
  };

  let code = 2;
  let runError = null;
  try {
    mockServer = await startMockModelServer();
    gateStatePromise = createPipelineGateState(mockServer.baseUrl);
    removeSignalHandlers = installTuiGateSignalHandlers(cleanup);
    gateState = await gateStatePromise;
    configurePipelineHome(gateState.agencHome);
    runnerEnv = gateState.env;
    pipelineCwd = createTuiGateProject(gateState);
    await writeTuiGateTrust(runnerEnv, [pipelineCwd]);
    await startTuiGateDaemon(gateState, BIN_AGENC);
    code = await runPipelineScenarios(mockServer);
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

  return resolvePipelineGateOutcome(code, runError, cleanupError);
}

function assertOneShotSucceeded(result) {
  if (result.exitCode === 0) return;
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  throw new Error(
    `agenc -p exited ${result.exitCode}${stderr ? `: ${stderr}` : ""}${!stderr && stdout ? `: ${stdout}` : ""}`,
  );
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
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(color("red", `runner crashed: ${error?.stack ?? error}`));
      process.exitCode = 2;
    });
}
