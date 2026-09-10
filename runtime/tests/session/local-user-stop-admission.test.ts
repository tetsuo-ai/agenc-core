import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { parseRolloutLine, type RolloutItem } from "../../src/session/rollout-item.js";
import { runTurn, type RunTurnOptions } from "../../src/session/run-turn.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agenc-local-stop-admission-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const session = mkSession({ cwd: directory }).session;
  cleanups.push(() => session.shutdown());
  const store = new RolloutStore({ cwd: directory, sessionId: session.conversationId, agencHome: join(directory, "home"), sessionTempRoot: join(directory, "scratch"), agencVersion: "0.17.0", autoStartScheduler: false });
  store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd: directory, originator: "local-stop-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
  session.mountRolloutStore(store);
  cleanups.push(() => { session.mountRolloutStore(null); store.close(); });
  const read = (): RolloutItem[] => readFileSync(store.rolloutPath, "utf8").trim().split("\n").map(line => parseRolloutLine(line)!).filter(Boolean);
  session.markStoppedByUser();
  const run = (options: RunTurnOptions & { userStopGenerationToRelease?: number }) => drain(runTurn(session, mkCtx({ cwd: directory }), "fresh human instruction", options));
  return { session, store, read, run };
}

describe("local human stop release admission", () => {
  it("persists exactly one real instruction before releasing the stop", async () => {
    const state = fixture();
    const clear = state.session.clearUserStop.bind(state.session);
    const release = vi.spyOn(state.session, "clearUserStop").mockImplementation(() => {
      expect(state.read().filter(item => item.type === "response_item" && item.payload.role === "user")).toHaveLength(1);
      expect(JSON.stringify(state.read())).toContain("fresh human instruction");
      clear();
    });
    await state.run({ userStopGenerationToRelease: state.session.userStopGeneration });
    expect(release).toHaveBeenCalledTimes(1);
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(false);
    expect(state.read().filter(item => item.type === "event_msg" && item.payload.msg.type === "user_message")).toHaveLength(1);
  });

  it("keeps the stop closed when the instruction durability barrier fails", async () => {
    const state = fixture();
    const release = vi.spyOn(state.session, "clearUserStop");
    vi.spyOn(state.store, "flushDurable").mockImplementation(() => { throw new Error("instruction fsync failed"); });
    await expect(state.run({ userStopGenerationToRelease: state.session.userStopGeneration })).rejects.toThrow("instruction fsync failed");
    expect(release).not.toHaveBeenCalled();
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
    expect(state.read().filter(item => item.type === "session_state" && item.payload.userStop?.stopped === false)).toHaveLength(0);
  });

  it("never persists a release marker without the preceding durable instruction even if release fails", async () => {
    const state = fixture();
    const append = state.store.appendRollout.bind(state.store);
    vi.spyOn(state.store, "appendRollout").mockImplementation((item, options) => {
      append(item, options);
      if (item.type === "session_state" && item.payload.userStop?.stopped === false) throw new Error("release fsync failed after write");
    });
    await expect(state.run({ userStopGenerationToRelease: state.session.userStopGeneration })).rejects.toThrow("release fsync failed after write");
    const items = state.read();
    const instructionIndex = items.findIndex(item => item.type === "response_item" && item.payload.role === "user");
    const releaseIndex = items.findIndex(item => item.type === "session_state" && item.payload.userStop?.stopped === false);
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(instructionIndex);
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
  });

  it.each([undefined, 0])("does not release for absent or stale human ingress generation %s", async userStopGenerationToRelease => {
    const state = fixture();
    const release = vi.spyOn(state.session, "clearUserStop");
    await state.run({ userStopGenerationToRelease });
    expect(release).not.toHaveBeenCalled();
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
  });

  it("cannot release a persisted stop without its canonical rollout store", async () => {
    const state = fixture();
    state.session.mountRolloutStore(null);
    const release = vi.spyOn(state.session, "clearUserStop");
    await expect(state.run({ userStopGenerationToRelease: state.session.userStopGeneration })).rejects.toThrow("requires a durable human instruction");
    expect(release).not.toHaveBeenCalled();
    expect(state.session.stoppedByUserSinceLastPrompt).toBe(true);
  });
});
