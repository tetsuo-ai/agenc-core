import { describe, it, expect } from "vitest";
import {
  compareSuggestionsByPriority,
  hasNameOrAliasPrefixMatch,
  type RankableMeta,
} from "../../../utils/suggestions/sortBySearchPriority.js";

/**
 * Slash typeahead exact-match highlight gate.
 *
 * The picker's selectedSuggestion is bound to index 0 of the sorted
 * suggestion list — see useTypeahead.tsx:778-782 where setSuggestionsState
 * writes selectedSuggestion: 0 every time the input changes. So as long as
 * the comparator places the exact-match command at index 0, the picker's
 * '❯' pointer lands on it.
 *
 * A PTY-based gate scenario for this surface was attempted under
 * scripts/check-tui-e2e and dropped: Ink's terminal reconciler skips
 * writes for unchanged characters, so the captured PTY byte-stream
 * doesn't reflect visual state — only deltas. Asserting via grep on
 * the stream produced false negatives. This unit-level assertion
 * captures the real contract.
 */

const meta = (
  name: string,
  opts: { aliases?: string[]; usage?: number; score?: number } = {},
): RankableMeta => ({
  name,
  aliases: opts.aliases ?? [],
  usage: opts.usage ?? 0,
  ...(opts.score !== undefined ? { score: opts.score } : {}),
});

const sortByPriority = (items: RankableMeta[], query: string): string[] =>
  [...items]
    .sort((a, b) => compareSuggestionsByPriority(a, b, query))
    .map((i) => i.name);

describe("slash typeahead: exact-match wins index 0", () => {
  it("places /exit before /exit-worktree when user typed '/exit'", () => {
    const order = sortByPriority(
      [meta("exit-worktree"), meta("exit"), meta("clear"), meta("help")],
      "exit",
    );
    expect(order[0]).toBe("exit");
    expect(order[1]).toBe("exit-worktree");
  });

  it("places /agents before /agent-foo when user typed '/agents'", () => {
    const order = sortByPriority(
      [meta("agent-foo"), meta("agents"), meta("agent-bar")],
      "agents",
    );
    expect(order[0]).toBe("agents");
  });

  it("places exact alias match above prefix-only siblings", () => {
    const order = sortByPriority(
      [meta("login"), meta("logs", { aliases: ["log"] }), meta("logout")],
      "log",
    );
    expect(order[0]).toBe("logs");
  });

  it("places shorter prefix above longer when no exact match", () => {
    const order = sortByPriority(
      [meta("compactify"), meta("compact"), meta("compact-history")],
      "comp",
    );
    expect(order[0]).toBe("compact");
  });

  it("Fuse-score margin only kicks in when name/alias rules are tied", () => {
    // Both pure-fuzzy candidates (no exact, no prefix). Lower score wins.
    const order = sortByPriority(
      [meta("foo", { score: 0.6 }), meta("bar", { score: 0.1 })],
      "qz",
    );
    expect(order[0]).toBe("bar");
  });

  it("usage breaks ties when neither match-class nor Fuse-score differ enough", () => {
    // Both pure-fuzzy with identical scores. Higher usage wins.
    const order = sortByPriority(
      [meta("foo", { score: 0.4, usage: 1 }), meta("bar", { score: 0.4, usage: 5 })],
      "qz",
    );
    expect(order[0]).toBe("bar");
  });

  it("does not treat description-only fuzzy hits as slash command matches", () => {
    expect(
      hasNameOrAliasPrefixMatch(
        meta("clear", { aliases: ["reset", "new"] }),
        "history",
      ),
    ).toBe(false);
    expect(hasNameOrAliasPrefixMatch(meta("clear"), "cle")).toBe(true);
    expect(
      hasNameOrAliasPrefixMatch(
        meta("provider"),
        "prov",
      ),
    ).toBe(true);
  });
});
