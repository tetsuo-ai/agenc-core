import { cronOsHomeWorkerPrelude } from "../helpers/cron-os-home.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readCronFile, writeCronTasks } from "../../src/utils/cronTasks.js";
import { CRON_DELIVERY_LEASE_MS } from "../../src/utils/cron-delivery-state.js";

const CREATED_AT = Date.parse("2026-07-09T10:00:00Z");
const DUE_AT = CREATED_AT + 60_000;
const runnerUrl = new URL("../../src/gateway/cron-delivery.ts", import.meta.url).href;
const outboxUrl = new URL("../../src/gateway/cron-outbox.ts", import.meta.url).href;
const workerSource = `
${cronOsHomeWorkerPrelude}
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
const { startCronDelivery } = await import(${JSON.stringify(runnerUrl)});
const { CronDeliveryOutboxStore } = await import(${JSON.stringify(outboxUrl)});
const [workspace, mode, nowText] = process.argv.slice(1);
const now = Number(nowText);
const record = async (event) => appendFile(join(workspace, "external-effects.jsonl"), JSON.stringify(event) + "\\n", { mode: 0o600 });
if (mode === "before_completion") {
  CronDeliveryOutboxStore.prototype.complete = async () => process.exit(17);
}
try {
  const session = {
    sessionId: "process-session",
    async prompt() {
      await record({ kind: "model" });
      if (mode === "hold") {
        const input = once(process.stdin, "data");
        process.stdin.resume();
        process.stdout.write("HOLDING\\n");
        await input;
        process.stdin.pause();
      }
      return { stopReason: "completed", finalMessage: "persisted process result" };
    },
  };
  let fire;
  let armed;
  const ready = new Promise((resolve) => { armed = resolve; });
  const handle = startCronDelivery({
    agencHome: join(workspace, "home"), workspaceDir: workspace, config: {},
    client: { createSession: async () => session, attachSession: async () => session, close: async () => {} },
    adapters: [{
      id: "test", supportsEdit: false, start: async () => {}, stop: async () => {},
      async send(message) {
        if (mode === "after_result") process.exit(17);
        await record({ kind: "channel", key: message.idempotencyKey });
        if (mode === "after_channel_ack") process.exit(17);
        return "message-id";
      },
    }],
    postWebhook: async (_url, _body, key) => record({ kind: "webhook", key }),
    log: (line) => process.stdout.write(line + "\\n"),
    clock: {
      now: () => new Date(now),
      setTimer: (callback) => { fire = callback; armed(); return 1; },
      clearTimer: () => {},
    },
  });
  await ready;
  await fire();
  await handle.stop();
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(2);
}
`;

let workspace: string;
const workers = new Set<{
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ code: number | null; stdout: string; stderr: string }>;
}>();

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agenc-cron-process-"));
  await writeCronTasks([{
    id: "delivery", cron: "* * * * *", prompt: "scheduled prompt", createdAt: CREATED_AT,
    deliver: { channel: "test", to: "ops", webhook: "https://hooks.example/result" },
  }], workspace);
});

afterEach(async () => {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
  }
  await Promise.all([...workers].map((worker) => worker.completion));
  workers.clear();
  await rm(workspace, { recursive: true, force: true });
});

function launch(mode: string, now = DUE_AT, workspacePath = workspace) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", workerSource,
    workspacePath, mode, String(now),
  ], { cwd: join(import.meta.dirname, "../.."), stdio: "pipe",
    env: { ...process.env, HOME: join(workspace, `os-env-${mode}`), AGENC_HOME: join(workspace, `agent-home-${mode}`) },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const worker = { child, completion };
  workers.add(worker);
  return {
    ...worker,
    async waitForModel() {
      await vi.waitFor(() => expect(stdout, stderr).toContain("HOLDING"), { timeout: 10_000 });
    },
  };
}

async function effects(): Promise<Array<{ kind: string; key?: string }>> {
  return (await readFile(join(workspace, "external-effects.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
}

describe("cron delivery process recovery", () => {
  test.each(["after_result", "after_channel_ack", "before_completion"])("recovers after process exit at %s", async (point) => {
    const crashed = await launch(point).completion;
    expect(crashed.code, crashed.stderr).toBe(17);
    const state = await readCronFile(workspace);
    expect(state.tasks).toHaveLength(1);
    expect(state.deliveryOutbox?.occurrences[0]?.model.status).toBe("delivered");
    expect(state.deliveryOutbox?.occurrences[0]?.lease).toBeDefined();
    const recovered = await launch("finish", DUE_AT + CRON_DELIVERY_LEASE_MS + 1).completion;
    expect(recovered.code, recovered.stderr).toBe(0);
    const recorded = await effects();
    expect(recorded.filter((event) => event.kind === "model")).toHaveLength(1);
    const channels = recorded.filter((event) => event.kind === "channel");
    expect(channels).toHaveLength(point === "after_channel_ack" ? 2 : 1);
    expect(new Set(channels.map((event) => event.key)).size).toBe(1);
    expect(channels[0]?.key).toMatch(/^[a-f0-9]{64}$/);
    expect(recorded.filter((event) => event.kind === "webhook")).toHaveLength(1);
    expect((await readCronFile(workspace)).tasks).toEqual([]);
  }, 30_000);

  test("shares an execution lock across processes, aliases, and homes even after lease expiry", async () => {
    const owner = launch("hold");
    await owner.waitForModel();
    const before = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!;
    const contenderTime = DUE_AT + CRON_DELIVERY_LEASE_MS + 1;
    expect(before.lease!.expiresAt).toBeLessThan(contenderTime);
    const alias = `${workspace}-alias`;
    await symlink(workspace, alias, "dir");
    let contender: Awaited<ReturnType<typeof launch>["completion"]>;
    try { contender = await launch("finish", contenderTime, alias).completion; }
    finally { await rm(alias); }
    expect(contender.code, contender.stderr).toBe(0);
    expect(contender.stdout).toContain("delivery deferred");
    expect((await effects()).filter((event) => event.kind === "model")).toHaveLength(1);
    expect((await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!.lease).toEqual(before.lease);
    owner.child.stdin.write("continue\n");
    const finished = await owner.completion;
    expect(finished.code, finished.stderr).toBe(0);
    expect((await readCronFile(workspace)).tasks).toEqual([]);
    expect((await effects()).filter((event) => event.kind === "model")).toHaveLength(1);
  }, 30_000);
});
