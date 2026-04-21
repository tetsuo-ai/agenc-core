/**
 * Tests for the palette item suppliers.
 *
 * `getSlashCommandItems` is tested against a hand-rolled registry stub so
 * we don't have to build a full AgenC runtime context.
 *
 * `getMentionItems` is tested against a real tmpdir created via
 * `fs.mkdtemp`. memfs is not on the runtime's dep list, and pulling it in
 * just for this test suite would violate the "no new npm deps" rule for
 * Wave 3-B.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getMentionItems,
  getSlashCommandItems,
  MENTION_RESULT_CAP,
  type SlashCommandLike,
  type SlashCommandRegistryLike,
} from "./palette-sources.js";

function makeRegistry(
  entries: ReadonlyArray<SlashCommandLike>,
): SlashCommandRegistryLike {
  return {
    list: () => entries,
  };
}

describe("getSlashCommandItems", () => {
  test("filters out userInvocable: false entries", () => {
    const registry = makeRegistry([
      { name: "help", description: "show help", userInvocable: true },
      { name: "internalHook", description: "hidden", userInvocable: false },
      { name: "status", description: "status" },
    ]);
    const items = getSlashCommandItems(registry);
    const names = items.map((item) => item.id);
    expect(names).toContain("help");
    expect(names).toContain("status");
    expect(names).not.toContain("internalHook");
  });

  test("prefixes labels and values with '/'", () => {
    const registry = makeRegistry([
      { name: "help", description: "show help" },
      { name: "exit", description: "leave" },
    ]);
    const items = getSlashCommandItems(registry);
    const help = items.find((item) => item.id === "help");
    const exit = items.find((item) => item.id === "exit");
    expect(help?.label).toBe("/help");
    expect(help?.value).toBe("/help");
    expect(help?.description).toBe("show help");
    expect(exit?.label).toBe("/exit");
    expect(exit?.value).toBe("/exit");
  });

  test("surfaces aliases and local-command metadata for discovery", () => {
    const registry = makeRegistry([
      {
        name: "context",
        aliases: ["ctx"],
        description: "inspect context",
        immediate: true,
      },
    ]);
    const item = getSlashCommandItems(registry)[0];
    expect(item?.keywords).toContain("ctx");
    expect(item?.description).toContain("local");
    expect(item?.description).toContain("/ctx");
  });
});

describe("getMentionItems", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agenc-palette-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore failures so we don't mask test output.
    }
  });

  test("returns an empty list for a non-existent cwd", async () => {
    const bogus = path.join(tmpRoot, "does", "not", "exist");
    const items = await getMentionItems(bogus, "");
    expect(items).toEqual([]);
  });

  test("skips node_modules directories during the walk", async () => {
    await fs.writeFile(path.join(tmpRoot, "keep.ts"), "ok");
    const nm = path.join(tmpRoot, "node_modules", "junk");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "ignore.ts"), "no");
    const items = await getMentionItems(tmpRoot, "");
    const labels = items.map((item) => item.label);
    expect(labels).toContain("keep.ts");
    for (const label of labels) {
      expect(label.startsWith("node_modules")).toBe(false);
    }
  });

  test(
    "bounds the result set to MENTION_RESULT_CAP",
    async () => {
      // Emit 250 shallow files. Walker must cap at MENTION_RESULT_CAP.
      const count = MENTION_RESULT_CAP + 50;
      const writes: Array<Promise<void>> = [];
      for (let i = 0; i < count; i += 1) {
        writes.push(
          fs.writeFile(path.join(tmpRoot, `file-${i}.txt`), String(i)),
        );
      }
      await Promise.all(writes);
      const items = await getMentionItems(tmpRoot, "");
      expect(items.length).toBeLessThanOrEqual(MENTION_RESULT_CAP);
      expect(items.length).toBeGreaterThan(0);
    },
    20_000,
  );

  test("filters by query substring on the base name", async () => {
    await fs.writeFile(path.join(tmpRoot, "alpha.ts"), "a");
    await fs.writeFile(path.join(tmpRoot, "beta.ts"), "b");
    await fs.writeFile(path.join(tmpRoot, "gamma.js"), "g");
    const items = await getMentionItems(tmpRoot, "alp");
    const labels = items.map((item) => item.label);
    expect(labels).toContain("alpha.ts");
    expect(labels).not.toContain("beta.ts");
    expect(labels).not.toContain("gamma.js");
  });
});
