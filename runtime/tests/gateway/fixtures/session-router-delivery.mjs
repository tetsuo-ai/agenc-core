import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { SessionRouter } from "../../../src/gateway/session-router.ts";

const [home, mode] = process.argv.slice(2);
const prompt = Promise.withResolvers();
const ready = Promise.withResolvers();
const failure = new Error("strict-mode delivery failure");
const failAt = mode === "edit" ? 2 : 1;
let sends = 0;
let promptSettled = false;
const session = {
  sessionId: "strict-session",
  async prompt(_text, handlers) {
    ready.resolve(handlers);
    await prompt.promise;
    promptSettled = true;
    return { stopReason: "completed", finalMessage: "done" };
  },
};
const router = new SessionRouter({
  agencHome: home,
  client: {
    createSession: async () => session,
    attachSession: async () => session,
    close: async () => {},
  },
  flushIntervalMs: 0,
});
const outcome = router.runTurn({
  key: "strict", text: "test", conversationId: "strict",
  adapter: {
    id: "strict", supportsEdit: true,
    start: async () => {}, stop: async () => {},
    send() {
      sends += 1;
      if (sends !== failAt) return Promise.resolve("message-id");
      if (mode === "sync") throw failure;
      return Promise.reject(failure);
    },
  },
  onPermissionRequest: async () => ({ behavior: "deny" }),
}).then(value => ({ value }), error => ({ error }));
try {
  const handlers = await ready.promise;
  handlers.onEvent({ type: "text", delta: "first" });
  await nextEventLoopTurn();
  if (mode === "edit") {
    handlers.onEvent({ type: "text", delta: "second" });
  }
  handlers.onEvent({ type: "text", delta: "queued" });
  await nextEventLoopTurn();
  handlers.onEvent({ type: "text", delta: "late" });
  await nextEventLoopTurn();
  assert.equal(promptSettled, false);
  assert.equal(sends, failAt);
  prompt.resolve();
  assert.equal((await outcome).error, failure);
  process.stdout.write(JSON.stringify({ mode, sends, retainedOriginalError: true }) + "\n");
} finally {
  prompt.resolve();
  await outcome;
}
