import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, test } from "vitest";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test("rebuilds exact duplicate protection after SIGKILL and loss of the rebuildable index", async () => {
  root = mkdtempSync(join(tmpdir(), "pair-crash-"));
  const cwd = join(root, "work"), agencHome = join(root, "home");
  mkdirSync(cwd); mkdirSync(agencHome, { mode: 0o700 });
  const id = "pair-crash";
  const opts = { cwd, agencHome, sessionId: id, agencVersion: "0.19.11",
    sessionTempRoot: root, autoStartScheduler: false };
  const meta = { sessionId: id, timestamp: "2026-10-19T00:00:00.000Z",
    cwd, originator: "pair-crash-test", agencVersion: "0.19.11" };
  const item = { type: "response_item" as const, payload: { role: "assistant",
    content: "", toolCalls: [{ id: "durable-call", name: "Read" }] } };
  const moduleUrl = new URL("../../src/session/rollout-store.ts", import.meta.url).href;
  const script = `import { RolloutStore } from ${JSON.stringify(moduleUrl)};
    const store = new RolloutStore(${JSON.stringify(opts)});
    store.open(${JSON.stringify(meta)});
    store.appendRollout(${JSON.stringify(item)}, { durable: true });
    process.stdout.write("COMMITTED\\n");
    await new Promise(() => setInterval(() => {}, 1000));`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script],
    { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  try {
    const output = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    expect((await output.next()).value, stderr).toBe("COMMITTED");
  } finally {
    child.kill("SIGKILL"); await closed;
  }
  const driver = openStateDatabases({ cwd, agencHome, deferLogs: true });
  try {
    // A process crash retains the NORMAL WAL commit before reconstruction.
    expect(driver.prepareState("SELECT call_id FROM tool_pair_projection_entries WHERE call_id = 'durable-call'").get())
      .toEqual({ call_id: "durable-call" });
    // Inject the permitted power-loss outcome: projection rows disappear;
    // fsynced canonical bytes and all authoritative tables remain intact.
    driver.transactionImmediate(() => driver.state.exec("DELETE FROM tool_pair_projection_runs"));
  } finally { driver.close(); }
  const resumed = new RolloutStore({ ...opts, resume: true });
  try {
    resumed.open(meta);
    expect(() => resumed.appendRollout(item, { durable: true }))
      .toThrow(/duplicate|already|tool.pair/iu);
  } finally { resumed.close(); }
}, 30_000);
