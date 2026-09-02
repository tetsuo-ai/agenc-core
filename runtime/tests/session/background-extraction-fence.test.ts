/**
 * The suite-wide fence over the turn-end memory-extraction fork, and the
 * proof that it is load-bearing.
 *
 * Class of defect: the fork used to be awaited inside runTurn
 * (`drainPendingExtraction()`), and no longer is. The extraction child is now
 * detached, and it samples the SESSION'S OWN provider (in a test, the test's
 * own mock) on a cadence of every third eligible terminating turn. So a test
 * that counts model calls or post-sampling launches can see extra samples it
 * never asked for, and whether it does is wall clock. Worse, the lane is keyed
 * by conversation id, so in a file whose sessions share one id the fork fires
 * in whichever test is running when the shared counter reaches three, not in
 * the test that drove the turns.
 *
 * That had already been patched twice, one file at a time. The fence is now
 * central: tests/helpers/hermetic-env.mjs pins
 * MEMORY_EXTRACTION_FENCE_ENV_VAR for every hermetic run.
 *
 * Both halves live here on purpose:
 *   - "stays out of a turn-counting test" fails if the pin is removed;
 *   - "opting back in puts the child's samples on the same mock" fails if the
 *     fork stops being able to reach a test's provider at all, at which point
 *     the pin has become decorative and should be re-argued rather than kept
 *     out of habit.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { runTurn } from "./run-turn.js";
import { drainPendingExtraction } from "../services/extractMemories/extractMemories.js";
import { MEMORY_EXTRACTION_FENCE_ENV_VAR } from "../helpers/hermetic-env.mjs";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { LLMMessage } from "../llm/types.js";

/** Stable marker text from the extraction child's own task prompt. */
const EXTRACTION_PROMPT_MARKER = "## How to save memories";

/** Past the default cadence (every third eligible turn) with room to spare. */
const TURNS = 4;

async function driveTurns(): Promise<readonly LLMMessage[][]> {
  const samples: LLMMessage[][] = [];
  const { session } = mkSession({
    provider: mkProvider(
      { content: "ok" },
      { onChatStream: (messages) => samples.push(messages) },
    ),
  });
  for (let turn = 0; turn < TURNS; turn += 1) {
    await drain(runTurn(session, mkCtx(), `hello ${turn}`));
  }
  // Deterministic, not a sleep: the fork registers its promise synchronously
  // when commit.ts calls it, so this awaits every extraction the turns
  // started (including a trailing run coalesced onto the same lane).
  await drainPendingExtraction(20_000);
  return samples;
}

function extractionSamples(
  samples: readonly LLMMessage[][],
): readonly LLMMessage[][] {
  return samples.filter((messages) =>
    messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes(EXTRACTION_PROMPT_MARKER),
    ),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("background memory extraction is fenced for the suite", () => {
  test("a turn-counting test sees exactly one sample per turn", async () => {
    const samples = await driveTurns();

    // The symptom first: removing the pin fails here, on the extra samples
    // themselves, rather than on the missing variable that let them in.
    expect(extractionSamples(samples)).toEqual([]);
    expect(samples).toHaveLength(TURNS);
    expect(process.env[MEMORY_EXTRACTION_FENCE_ENV_VAR]).toBe("1");
  });

  test("opting back in puts the extraction child's samples on the same mock", async () => {
    // The opt-in a test that genuinely exercises extraction would use. It runs
    // after the setup file's own hook, so it wins over the pin.
    vi.stubEnv(MEMORY_EXTRACTION_FENCE_ENV_VAR, "0");

    const samples = await driveTurns();

    // Falsifies the fence: without it these are the samples a turn-counting
    // assertion would have absorbed.
    expect(extractionSamples(samples).length).toBeGreaterThan(0);
    expect(samples.length).toBeGreaterThan(TURNS);
  });
});
