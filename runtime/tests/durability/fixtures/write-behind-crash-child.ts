import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { withSessionWriteBehind } from "../../../src/session/write-behind.js";
import { ProviderHttpClientSession } from "../../../src/llm/client-session.js";
import { openStateDatabases } from "../../../src/state/sqlite-driver.js";
import { StateRunDurabilityRepository } from "../../../src/state/run-durability.js";
import type { Event } from "../../../src/session/event-log.js";

const [command, root, url, mode] = process.argv.slice(2);
if (!root) throw new Error("missing root");
const cwd = join(root, "workspace"), home = join(root, "home");
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
const pathRecord = join(root, "rollout-path");
const store = new RolloutStore({
  cwd, agencHome: home, sessionId: "write-behind-crash", agencVersion: "test",
  sessionTempRoot: root, autoStartScheduler: false,
  ...(command === "recover" ? { resume: true, resumeRolloutPath: readFileSync(pathRecord, "utf8") } : {}),
});
store.open({ cwd, sessionId: "write-behind-crash", agencVersion: "test", originator: "test", timestamp: "2026-10-08T00:00:00.000Z" });
if (command === "recover") {
  const events = store.readAll().filter(item => item.type === "event_msg" && item.payload.msg.type === "warning").map(item => item.payload.id);
  const driver = openStateDatabases({ cwd, agencHome: home, deferLogs: true });
  const effect = new StateRunDurabilityRepository(driver).getEffect("write-behind-crash", "tool-step");
  driver.close();
  store.close();
  process.stdout.write(JSON.stringify({ events, effect }) + "\n");
} else {
  writeFileSync(pathRecord, store.rolloutPath);
  store.append({ id: "committed", eventId: "event:1", seq: 1,
    msg: { type: "warning", payload: { cause: "test", message: "previous step" } } }, { durable: true });
  const queue = store.store.writeBehind;
  await withSessionWriteBehind(queue, async () => {
    queue.beginStep();
    if (mode === "effect") {
      const payload = { formatVersion: 2 as const, minimumReaderRuntime: "0.14.0",
        runId: "write-behind-crash", stepId: "tool-step", callId: "call", toolName: "physical-counter",
        recoveryCategory: "side-effecting" as const, intentDigest: "digest", attempt: 1,
        recordedAt: "2026-10-08T00:00:01.000Z" };
      const intent: Event = { id: "intent", seq: 2, msg: { type: "effect_intent", payload } };
      store.append(intent, { durable: true });
      store.recordEffectEvent(intent);
      appendFileSync(join(root, "physical-effects"), "one invocation\n");
      const result: Event = { id: "result", seq: 3, msg: { type: "effect_result", payload: {
        ...payload, intentEventSeq: 2, outcome: "committed", effectBoundary: "crossed", resultDigest: "result",
      } } };
      store.append(result, { durable: true });
      store.recordEffectEvent(result);
    }
    store.append({ id: "last-step", eventId: "last-step", seq: mode === "effect" ? 4 : 2,
      msg: { type: "warning", payload: { cause: "test", message: "unflushed step" } } }, { durable: true });
    const client = new ProviderHttpClientSession({ providerName: "test", baseURL: url!, wireApi: "responses" });
    await client.requestText({ body: { next: true } });
    // The after-flush variant dies without running close or any shutdown hook.
    process.kill(process.pid, "SIGKILL");
  });
}
