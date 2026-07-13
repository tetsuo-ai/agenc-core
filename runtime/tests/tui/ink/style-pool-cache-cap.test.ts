import { describe, expect, it } from "vitest";
import { StylePool } from "../../../src/tui/ink/screen.js";

// core-todo.md ink.tsx:1642 / screen.ts StylePool: the StylePool is never rotated
// (unlike CharPool/HyperlinkPool), so its transitionCache — an O(usedStyles²)
// (fromId,toId) map — grew unbounded over a long truecolor session. It is now
// FIFO-capped.

describe("StylePool transition cache cap", () => {
  it("bounds the transition cache under many distinct style pairs", () => {
    const pool = new StylePool();
    const ids: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      ids.push(
        pool.intern([
          { code: `\x1b[38;5;${i}m`, endCode: "\x1b[39m", type: "ansi" },
        ]),
      );
    }

    // 200*200 = 40000 (fromId,toId) pairs; ~39800 are cacheable (self-pairs
    // return "" without caching). Unbounded this would cache them all.
    for (const from of ids) {
      for (const to of ids) {
        pool.transition(from, to);
      }
    }

    expect(pool.transitionCacheSizeForTest()).toBeLessThanOrEqual(16_384);
  });
});
