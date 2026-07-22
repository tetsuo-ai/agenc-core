import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { LLMStreamChunk } from "../../types.js";
import { GrokProvider } from "./adapter.js";

// LIVE wire probe — talks to the real xAI API with the local OAuth grant.
// Only runs when GROK_WIRE_PROBE=1: measures inter-chunk gap distribution
// during (A) a reasoning-heavy no-tools turn and (B) a large tool-argument
// generation, to establish whether grok-4.5 ever goes wire-silent long
// enough to starve the 90s session stream watchdog even with every event
// mapped to a chunk (the stream-liveness fix).

const RUN = process.env.GROK_WIRE_PROBE === "1";

function oauthBearer(): string {
  const credentials = JSON.parse(
    readFileSync(join(homedir(), ".agenc", ".credentials.json"), "utf8"),
  ) as { xaiOauth?: { accessToken?: string } };
  const token = credentials.xaiOauth?.accessToken;
  if (!token) throw new Error("no xai oauth access token available");
  return token;
}

interface GapStats {
  chunks: number;
  maxGapMs: number;
  gapsOver5s: number[];
  kinds: Record<string, number>;
  wallMs: number;
}

async function probe(
  prompt: string,
  tools: import("../../types.js").LLMTool[] | undefined,
): Promise<GapStats> {
  const provider = new GrokProvider({
    apiKey: oauthBearer(),
    model: "grok-4.5",
  });
  const stats: GapStats = {
    chunks: 0,
    maxGapMs: 0,
    gapsOver5s: [],
    kinds: {},
    wallMs: 0,
  };
  const startedAt = Date.now();
  let lastAt = startedAt;
  const onChunk = (chunk: LLMStreamChunk): void => {
    const now = Date.now();
    const gap = now - lastAt;
    lastAt = now;
    stats.chunks += 1;
    if (gap > stats.maxGapMs) stats.maxGapMs = gap;
    if (gap > 5_000) stats.gapsOver5s.push(gap);
    const kind = chunk.done
      ? "done"
      : chunk.toolInputDelta
        ? "toolInputDelta"
        : chunk.toolInputBlockStart
          ? "toolInputBlockStart"
          : chunk.reasoningSummaryDelta
            ? "reasoning"
            : chunk.content.length > 0
              ? "content"
              : "heartbeat";
    stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
  };
  await provider.chatStream(
    [{ role: "user", content: prompt }],
    onChunk,
    tools ? { tools } : undefined,
  );
  stats.wallMs = Date.now() - startedAt;
  return stats;
}

describe.runIf(RUN)("grok-4.5 wire gap probe (LIVE)", () => {
  it(
    "A: reasoning-heavy turn — measure silent gaps",
    { timeout: 360_000 },
    async () => {
      const stats = await probe(
        "Prove or disprove: every positive integer can be written as the sum " +
          "of at most three palindromic numbers in base 10. Reason carefully " +
          "step by step about the known literature and edge cases before " +
          "answering, then give a one-paragraph answer.",
        undefined,
      );
      console.log("PROBE-A", JSON.stringify(stats));
      expect(stats.chunks).toBeGreaterThan(0);
    },
  );

  it(
    "B: large tool-argument generation — do arguments stream?",
    { timeout: 360_000 },
    async () => {
      const stats = await probe(
        "Call write_file exactly once to create lexer.c: a complete ~200-line " +
          "C99 POSIX shell lexer with operator recognition, word splitting, " +
          "and quote handling. Put the ENTIRE file content in the content " +
          "argument. Do not explain anything.",
        [
          {
            type: "function",
            function: {
              name: "write_file",
              description: "Write a file to disk",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
          },
        ],
      );
      console.log("PROBE-B", JSON.stringify(stats));
      expect(stats.chunks).toBeGreaterThan(0);
    },
  );
});
