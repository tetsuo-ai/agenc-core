import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { withSessionWriteBehind } from "../../../src/session/write-behind.js";
import { ProviderHttpClientSession } from "../../../src/llm/client-session.js";

const [command, root, url] = process.argv.slice(2);
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
  const events = store.readAll().filter(item => item.type === "event_msg").map(item => item.payload.id);
  store.close();
  process.stdout.write(JSON.stringify({ events }) + "\n");
} else {
  writeFileSync(pathRecord, store.rolloutPath);
  store.append({ id: "committed", eventId: "event:1", seq: 1,
    msg: { type: "warning", payload: { cause: "test", message: "previous step" } } }, { durable: true });
  const queue = store.store.writeBehind;
  await withSessionWriteBehind(queue, async () => {
    queue.beginStep();
    store.append({ id: "last-step", eventId: "event:2", seq: 2,
      msg: { type: "warning", payload: { cause: "test", message: "unflushed step" } } }, { durable: true });
    const client = new ProviderHttpClientSession({ providerName: "test", baseURL: url!, wireApi: "responses" });
    await client.requestText({ body: { next: true } });
    // The after-flush variant dies without running close or any shutdown hook.
    process.kill(process.pid, "SIGKILL");
  });
}
