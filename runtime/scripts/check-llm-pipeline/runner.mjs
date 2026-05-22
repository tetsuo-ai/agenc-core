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
 * Architecture: spawn a fresh `agenc -p '<prompt>'` (one-shot daemon
 * agent), wait for completion, then parse the rollout file the daemon
 * wrote to `~/.agenc/projects/<project>/sessions/<sid>/rollout-*.jsonl`.
 * The rollout is the daemon's authoritative record of every event in
 * the conversation, including tool calls with their full id/name/
 * arguments shape and the assembled message order. Pure offline
 * inspection — no PTY required.
 *
 * Why not vllm logs? VLLM's stdout only logs HTTP status (it
 * intentionally doesn't capture request bodies for privacy). The
 * daemon-side rollout has the same data the daemon sent to vllm,
 * just one layer up.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const PROJECTS_DIR = path.join(homedir(), ".agenc", "projects");

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

/**
 * Run agenc -p with a prompt and capture stdout. Returns { stdout, stderr, exitCode }.
 */
async function runOneShot(prompt, { yolo = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [BIN_AGENC];
    if (yolo) args.push("--yolo");
    args.push("-p", prompt);
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.on("error", reject);
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`one-shot exceeded ${timeoutMs}ms`));
    }, timeoutMs).unref();
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
  const projects = await readdir(PROJECTS_DIR);
  for (const proj of projects) {
    const sessionsDir = path.join(PROJECTS_DIR, proj, "sessions");
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

/* -------------------------------------------------------------------- */
/* Scenarios                                                             */
/* -------------------------------------------------------------------- */

const scenarios = [];

scenarios.push({
  name: "01-session-meta-first",
  description: "Rollout starts with session_meta describing model/cwd/version.",
  async run() {
    await runOneShot("reply with the single word HELLO and nothing else", {
      yolo: true,
      timeoutMs: 180_000,
    });
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
    await runOneShot("reply with the single word HELLO and nothing else", {
      yolo: true,
      timeoutMs: 180_000,
    });
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const turnIdx = items.findIndex((i) => i.type === "turn_context");
    const userIdx = items.findIndex(
      (i) =>
        (i.type === "event_msg" &&
          i.payload?.msg?.type === "user_message") ||
        (i.type === "response_item" &&
          i.payload?.role === "user"),
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
  description: "agenc --yolo -p produces turn_context with approvalPolicy='never'.",
  async run() {
    await runOneShot("reply with the single word YES", {
      yolo: true,
      timeoutMs: 180_000,
    });
    await sleep(500);
    const { items } = await readMostRecentRollout();
    const tc = items.find((i) => i.type === "turn_context");
    if (!tc) throw new Error("no turn_context in rollout");
    const policy = tc.payload?.approvalPolicy;
    if (policy !== "never") {
      throw new Error(
        `--yolo expected approvalPolicy='never', got '${policy}'. The yolo propagation chain (route.ts → daemon protocol → background-agent-runner.buildBootstrapArgv → bootstrap → sessionConfiguration) is broken.`,
      );
    }
    const sandbox = tc.payload?.sandboxPolicy;
    if (sandbox !== "danger_full_access") {
      throw new Error(
        `--yolo expected sandboxPolicy='danger_full_access', got '${sandbox}'`,
      );
    }
  },
});

scenarios.push({
  name: "04-tool-call-shape",
  description:
    "Tool invocations record tool_call_started + tool_call_completed with proper id/name/args.",
  async run() {
    await runOneShot(
      "Use the Bash tool to run: echo PIPELINE-TOOL-CHECK",
      { yolo: true, timeoutMs: 240_000 },
    );
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
    await runOneShot(
      "Use the Bash tool to run: echo TOKEN-CHECK",
      { yolo: true, timeoutMs: 240_000 },
    );
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
    await runOneShot("reply with the single word DONE", {
      yolo: true,
      timeoutMs: 180_000,
    });
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
    await runOneShot("reply with the single word RECORDED", {
      yolo: true,
      timeoutMs: 180_000,
    });
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

async function main() {
  console.log(color("bold", `agenc LLM pipeline gate (${scenarios.length} scenarios)`));
  console.log("");
  let passed = 0;
  const failed = [];
  for (const sc of scenarios) {
    process.stdout.write(`  ${color("dim", "→")} ${sc.name} … `);
    const startedAt = Date.now();
    try {
      await sc.run();
      const dur = Date.now() - startedAt;
      passed += 1;
      console.log(`${color("green", "PASS")} ${color("dim", `(${dur}ms)`)}`);
    } catch (error) {
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

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(color("red", `runner crashed: ${error?.stack ?? error}`));
    process.exit(2);
  });
