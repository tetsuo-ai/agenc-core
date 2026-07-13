/**
 * Regression: runMagicDocsPostSamplingHook chained every session's update onto
 * one module-global promise, so a second session's magic-docs update could not
 * start until the first session's (a full background subagent) finished. The
 * queue is now keyed per scope (session) like trackedMagicDocsByScope.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerMagicDoc,
  resetMagicDocsForTests,
  runMagicDocsPostSamplingHook,
  setMagicDocsAgentRunnerForTests,
} from "../../../src/services/MagicDocs/magicDocs.js";

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-magicdocs-queue-"));
  resetMagicDocsForTests();
});

afterEach(() => {
  resetMagicDocsForTests();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("magicDocs update queue — per-session isolation", () => {
  it("does not serialize session B's update behind a blocked session A", async () => {
    const docA = join(tempRoot, "A.md");
    const docB = join(tempRoot, "B.md");
    writeFileSync(docA, "# MAGIC DOC: Alpha\n\nbody A\n");
    writeFileSync(docB, "# MAGIC DOC: Bravo\n\nbody B\n");

    registerMagicDoc(docA, "sessionA");
    registerMagicDoc(docB, "sessionB");

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let bRan = false;

    setMagicDocsAgentRunnerForTests(async (request) => {
      if (request.docPath === docA) {
        await gateA; // session A's update blocks here
        return;
      }
      if (request.docPath === docB) {
        bRan = true;
      }
    });

    const context = (sessionId: string) => ({
      messages: [],
      sessionId,
      readFileState: new Map<string, unknown>(),
    });

    // Start A (which blocks inside the runner), then B.
    void runMagicDocsPostSamplingHook(context("sessionA"));
    const hookB = runMagicDocsPostSamplingHook(context("sessionB"));

    // B must finish without waiting on A. Race a deadline so a regression
    // (B queued behind the blocked A) fails fast instead of hanging.
    const outcome = await Promise.race([
      hookB.then(() => "b-done" as const),
      new Promise<"deadline">((resolve) => {
        setTimeout(() => resolve("deadline"), 1_000);
      }),
    ]);

    expect(bRan).toBe(true);
    expect(outcome).toBe("b-done");

    releaseA(); // let A drain so nothing dangles past the test
  });
});
