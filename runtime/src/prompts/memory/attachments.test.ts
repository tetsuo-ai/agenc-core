import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_MAX_BYTES_PER_FILE,
  ATTACHMENT_MAX_BYTES_PER_SESSION,
  ATTACHMENT_MAX_FILES_PER_TURN,
  _resetAttachmentBudgetForTest,
  attachmentBudgetFor,
  injectAttachmentsIntoPrompt,
  scoreMemory,
  selectRelevantMemoriesForTurn,
} from "./attachments.js";
import type { MemoryEntry, MemoryType } from "./types.js";

function entry(
  name: string,
  type: MemoryType,
  description: string,
  body = "body",
  mtimeMs = Date.now(),
): MemoryEntry {
  return {
    filePath: `/memdir/${name}.md`,
    frontmatter: { name, description, type, extra: {} },
    body,
    mtimeMs,
    byteLength: Buffer.byteLength(body, "utf8") + 100,
  };
}

describe("scoreMemory", () => {
  test("prefers feedback over project/reference/user on equal overlap", () => {
    const fb = entry("fb", "feedback", "testing policy for tests");
    const proj = entry("proj", "project", "testing policy for tests");
    const ref = entry("ref", "reference", "testing policy for tests");
    const user = entry("user", "user", "testing policy for tests");
    const msg = "what is our testing policy?";
    expect(scoreMemory(fb, msg)).toBeGreaterThan(scoreMemory(proj, msg));
    expect(scoreMemory(proj, msg)).toBeGreaterThan(scoreMemory(ref, msg));
    expect(scoreMemory(ref, msg)).toBeGreaterThan(scoreMemory(user, msg));
  });

  test("boosts keyword overlap strongly over type alone", () => {
    const hit = entry("k", "user", "database migrations and schema changes");
    const dull = entry("d", "feedback", "nothing relevant here");
    const msg = "tell me about database migrations";
    expect(scoreMemory(hit, msg)).toBeGreaterThan(scoreMemory(dull, msg));
  });
});

describe("selectRelevantMemoriesForTurn", () => {
  test("returns top-N sorted by relevance", () => {
    const key = {};
    _resetAttachmentBudgetForTest(key);
    const all = [
      entry("a", "user", "apples and oranges"),
      entry("b", "feedback", "database migrations guidance"),
      entry("c", "project", "unrelated topic"),
      entry("d", "reference", "database ops runbook"),
      entry("e", "user", "snacks"),
    ];
    const picked = selectRelevantMemoriesForTurn(
      all,
      "tell me about database migrations",
      key,
      { maxFiles: 2 },
    );
    expect(picked.length).toBe(2);
    expect(picked[0].frontmatter.name).toBe("b");
    expect(picked[1].frontmatter.name).toBe("d");
  });

  test("skips files larger than maxBytesPerFile", () => {
    const key = {};
    _resetAttachmentBudgetForTest(key);
    const bigBody = "x".repeat(5_000);
    const all = [
      entry("big", "feedback", "big memory", bigBody),
      entry("sm", "user", "small one"),
    ];
    const picked = selectRelevantMemoriesForTurn(all, "tell me small", key, {
      maxBytesPerFile: 4_000,
    });
    expect(picked.map((p) => p.frontmatter.name)).toEqual(["sm"]);
  });

  test("does not select memories on type or recency without overlap", () => {
    const key = {};
    _resetAttachmentBudgetForTest(key);
    const all = [
      entry("fresh-project", "project", "m5 shell implementation"),
      entry("fresh-feedback", "feedback", "renderer guidance"),
    ];
    const picked = selectRelevantMemoriesForTurn(
      all,
      "tell me about database migrations",
      key,
    );
    expect(picked).toEqual([]);
  });

  test("skips single-word and greeting prompts", () => {
    const key = {};
    _resetAttachmentBudgetForTest(key);
    const all = [entry("grok", "project", "grok model behavior")];

    expect(selectRelevantMemoriesForTurn(all, "grok", key)).toEqual([]);
    expect(selectRelevantMemoriesForTurn(all, "hello Grok", key)).toEqual([]);
  });

  test("respects per-session cumulative byte cap across turns", () => {
    const key = {};
    _resetAttachmentBudgetForTest(key);
    const mem = (n: string) =>
      entry(n, "user", "body generic", "body content", Date.now());
    // Force each entry to 1000 bytes.
    const sized = [
      { ...mem("a"), byteLength: 1000 },
      { ...mem("b"), byteLength: 1000 },
      { ...mem("c"), byteLength: 1000 },
      { ...mem("d"), byteLength: 1000 },
    ] as MemoryEntry[];

    const first = selectRelevantMemoriesForTurn(sized, "body content", key, {
      maxFiles: 4,
      maxBytesPerSession: 2_500,
    });
    expect(first.length).toBe(2);
    // Second call continues consuming the same session budget.
    const second = selectRelevantMemoriesForTurn(sized, "body content", key, {
      maxFiles: 4,
      maxBytesPerSession: 2_500,
    });
    // Only 500 bytes remain — no further 1KB entry fits.
    expect(second.length).toBe(0);
    const budget = attachmentBudgetFor(key, 2_500);
    expect(budget.bytesInjected).toBe(2_000);
    expect(budget.bytesRemaining).toBe(500);
  });

  test("ATTACHMENT caps match TODO.MD §T10-C defaults", () => {
    expect(ATTACHMENT_MAX_FILES_PER_TURN).toBe(5);
    expect(ATTACHMENT_MAX_BYTES_PER_FILE).toBe(4_000);
    expect(ATTACHMENT_MAX_BYTES_PER_SESSION).toBe(60_000);
  });
});

describe("injectAttachmentsIntoPrompt", () => {
  test("appends a Relevant memories section with serialized frontmatter", () => {
    const base = "SYSTEM PROMPT";
    const picked = [entry("demo", "feedback", "concrete feedback", "body text")];
    const out = injectAttachmentsIntoPrompt(base, picked);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain("## Relevant memories");
    expect(out).toContain("type: feedback");
    expect(out).toContain("body text");
  });

  test("no-ops when no memories selected", () => {
    expect(injectAttachmentsIntoPrompt("S", [])).toBe("S");
  });
});
