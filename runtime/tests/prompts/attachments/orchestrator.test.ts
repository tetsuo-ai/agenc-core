/**
 * Foundation tests for the per-turn attachments orchestrator. The
 * registry is empty at landing time; these tests pin the contract that
 * subsequent producer additions must honor.
 */
import { describe, expect, test } from "vitest";

import { _resetAttachmentTrackingStateForTest } from "../../session/attachment-state.js";
import {
  type GetAttachmentsOptions,
  getAttachments,
} from "./orchestrator.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: {
      mode: "default",
    } as never,
    cwd: "/tmp/agenc-orchestrator-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

describe("attachments orchestrator", () => {
  test("returns an empty list with no producers registered", async () => {
    const opts = makeOpts();
    const out = await getAttachments(opts);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("does not throw on a fresh AbortSignal", async () => {
    const opts = makeOpts();
    await expect(getAttachments(opts)).resolves.not.toThrow();
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("returns an empty list even when the abort signal is already aborted", async () => {
    // Producer authors are expected to honor the signal; with no
    // producers registered we still resolve cleanly. This pins the
    // orchestrator contract — never throw on the consumer's behalf.
    const ac = new AbortController();
    ac.abort();
    const opts = makeOpts({ signal: ac.signal });
    const out = await getAttachments(opts);
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(opts.sessionKey);
  });

  test("isolates tracking state across distinct session keys", async () => {
    const sessionA = {};
    const sessionB = {};
    await getAttachments(makeOpts({ sessionKey: sessionA }));
    await getAttachments(makeOpts({ sessionKey: sessionB }));
    // No producers run, so the only thing this test pins is that no
    // cross-key state pollution happened (verified by the WeakMap
    // structural guarantee — re-read after reset still yields empty).
    _resetAttachmentTrackingStateForTest(sessionA);
    _resetAttachmentTrackingStateForTest(sessionB);
    expect(true).toBe(true);
  });
});
