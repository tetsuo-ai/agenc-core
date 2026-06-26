import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOrientTool, ORIENT_TOOL_NAME } from "src/tools/system/orient";
import type { ToolResult } from "src/tools/types";

// Orient builds an ephemeral structural map of the workspace and returns a
// ranked shortlist of files for a natural-language query. These exercise the
// tool end-to-end against a real temp workspace + real ripgrep enumeration.

let dir: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orient-test-"));
  // A caller (payments/processor) that delegates to a deeply-named helper
  // (ledger/reconcile). Plus unrelated files + a node_modules dep that must be
  // ignored.
  await write(
    "src/payments/processor.ts",
    "export function processRefund(txn) {\n  return reconcileLedger(txn)\n}\n",
  );
  await write(
    "src/ledger/reconcile.ts",
    "export function reconcileLedger(t) {\n  return t.amount\n}\n",
  );
  await write("src/util/log.ts", "export function log(m) { return m }\n");
  await write("src/util/math.ts", "export function clamp(x) { return x }\n");
  await write(
    "node_modules/dep/index.ts",
    "export function processRefund() { return 'vendored' }\n",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function orient() {
  return createOrientTool({ allowedPaths: [dir] });
}

describe("Orient tool", () => {
  it("advertises a read-only, auto-approvable contract", () => {
    const tool = orient();
    expect(tool.name).toBe(ORIENT_TOOL_NAME);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.recoveryCategory).toBe("idempotent");
    expect(tool.inputSchema.required).toContain("query");
  });

  it("ranks the file defining a quoted query symbol near the top", async () => {
    const res: ToolResult = await orient().execute({
      query: "the `processRefund` function double-counts the amount on retry",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Orientation map for");
    expect(res.content).toContain("src/payments/processor.ts");
    // top file (line "1. <path>") should be the definer.
    const firstLine = res.content
      .split("\n")
      .find((l) => l.startsWith("1. "));
    expect(firstLine).toContain("src/payments/processor.ts");
    // metadata exposes the shortlist
    const top = res.metadata?.topFiles as string[] | undefined;
    expect(top?.[0]).toBe("src/payments/processor.ts");
  });

  it("ignores generated/vendored dirs (node_modules) during enumeration", async () => {
    const res = await orient().execute({ query: "processRefund" });
    expect(res.content).not.toContain("node_modules");
  });

  it("rejects an empty query", async () => {
    const res = await orient().execute({ query: "   " });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/non-empty/i);
  });

  it("rejects a path that escapes the allowed workspace", async () => {
    const res = await orient().execute({ query: "x", path: "../../../etc" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/outside the allowed workspace|traversal/i);
  });

  it("scopes the map to a subdirectory when path is given", async () => {
    const res = await orient().execute({ query: "reconcileLedger", path: "src/ledger" });
    expect(res.isError).toBeFalsy();
    // paths are relative to the scoped dir, so just the basename appears
    expect(res.content).toContain("reconcile.ts");
    // a file outside the scoped subdir must not appear
    expect(res.content).not.toContain("processor.ts");
  });
});
