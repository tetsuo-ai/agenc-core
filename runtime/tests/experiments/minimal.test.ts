import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentMinimal } from "../../src/experiment-minimal.js";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { SessionStore } from "../../src/session/session-store.js";
import { redactDurableSecrets } from "../../src/session/provider-replay-redaction.js";

afterEach(() => vi.unstubAllEnvs());

test("only exact opt-in removes admission and preserves model options/results", async () => {
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "true");
  expect(experimentMinimal()).toBe(false);
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "1");
  const options = { maxOutputTokens: 8192 };
  const result = { content: "answer", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test", finishReason: "stop" as const };
  const invoke = vi.fn(async () => result);
  // No services/provider access is permitted along this deliberately stripped path.
  const params = { options, invoke } as unknown as Parameters<typeof runAdmittedModelCall>[0];
  expect(await runAdmittedModelCall(params)).toBe(result);
  expect(invoke).toHaveBeenCalledWith(options);
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "0");
  await expect(runAdmittedModelCall(params)).rejects.toThrow();
});

test("tool bypass still propagates cancellation and the actual result", async () => {
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "1");
  const controller = new AbortController();
  const result = { content: "captured stdout", isError: false };
  const params = { signal: controller.signal, invoke: async (context: { signal: AbortSignal; crossEffectBoundary(): void }) => {
    context.crossEffectBoundary();
    controller.abort(new Error("stop"));
    expect(context.signal.aborted).toBe(true);
    expect(() => context.crossEffectBoundary()).toThrow("stop");
    return result;
  } } as unknown as Parameters<typeof runAdmittedToolCall>[0];
  expect(await runAdmittedToolCall(params)).toBe(result);
});

test("rollout is written at close, barriers and mirror are skipped, redaction is disabled", () => {
  const home = mkdtempSync(join(tmpdir(), "minimal-experiment-"));
  vi.stubEnv("AGENC_HOME", home);
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "1");
  const mirror = vi.fn();
  const store = new SessionStore({ cwd: home, sessionId: "minimal", agencVersion: "test" });
  try {
    store.open({ sessionId: "minimal", timestamp: new Date().toISOString(), cwd: home, originator: "test", agencVersion: "test" });
    const before = readFileSync(store.rolloutPath, "utf8");
    store.setOnRolloutCommitted(mirror);
    store.appendRollout({ type: "response_item", payload: { role: "user", content: "buffered-only" } }, { durable: true });
    expect(store.flushBatch(true)).toBe(true);
    expect(readFileSync(store.rolloutPath, "utf8")).toBe(before);
    store.close();
    expect(readFileSync(store.rolloutPath, "utf8")).toContain("buffered-only");
    expect(mirror).not.toHaveBeenCalled();
    const secret = { api_key: "experiment-value" };
    expect(redactDurableSecrets(secret, "ordinary")).toBe(secret);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});


test("minimal startup never runs auxiliary callbacks or the request journal wrapper", async () => {
  vi.stubEnv("AGENC_EXPERIMENT_MINIMAL", "1");
  const { createWarmSessionSetupCeiling } = await import("../../src/bin/warm-session-setup-ceiling.js");
  const ceiling = createWarmSessionSetupCeiling("/nonexistent-experiment-dir", "test");
  const setup = vi.fn();
  ceiling.register(setup);
  const transport = vi.fn(async () => new Response("ok"));
  expect(ceiling.wrap(transport)).toBe(transport);
  await ceiling.wrap(transport)("http://unused", { method: "POST", body: "{}" });
  await ceiling.close();
  expect(setup).not.toHaveBeenCalled();
});
