import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOrientTool, ORIENT_TOOL_NAME } from "src/tools/system/orient";
import type { ToolResult } from "src/tools/types";
import {
  sha256,
  workspaceMutationCoordinators,
  type WorkspaceEditorLease,
  type WorkspaceMutationCoordinator,
} from "src/workspace/mutation-coordinator";
import { bindExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";
import { attachToolRuntimeContext } from "../../src/tools/runtimes/context.js";

// Orient builds an ephemeral structural map of the workspace and returns a
// ranked shortlist of files for a natural-language query. These exercise the
// tool end-to-end against a real temp workspace + real ripgrep enumeration.

let dir: string;
let previousAgencHome: string | undefined;

async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orient-test-"));
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = join(dir, ".agenc-test-home");
  workspaceMutationCoordinators.clearForTests();
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
  workspaceMutationCoordinators.clearForTests();
  await rm(dir, { recursive: true, force: true });
  if (previousAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = previousAgencHome;
  }
});

function orient() {
  return bindExplicitDangerBoundary(createOrientTool({ allowedPaths: [dir] }));
}

function attachTrustedEditorContext(args: Record<string, unknown>): void {
  attachToolRuntimeContext(args, {
    callId: "trusted-editor-orient",
    toolName: ORIENT_TOOL_NAME,
    sandboxMode: "read_only",
    invocation: {
      turn: {
        editorInteraction: {
          interactionId: "trusted-editor-orient",
          policy: "read_only",
        },
      },
    },
  } as never);
}

function isWindowsExchangeDenial(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    process.platform === "win32" &&
    (code === "EPERM" || code === "EACCES" || code === "EBUSY")
  );
}

async function exchangeDirectory(
  current: string,
  displaced: string,
  outside: string,
): Promise<"exchanged" | "kernel_denied"> {
  try {
    await rename(current, displaced);
  } catch (error) {
    if (isWindowsExchangeDenial(error)) return "kernel_denied";
    throw error;
  }
  try {
    await symlink(
      outside,
      current,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    await rename(displaced, current).catch(() => {});
    if (isWindowsExchangeDenial(error)) return "kernel_denied";
    throw error;
  }
  return "exchanged";
}

function expectCompletedExchangeAttempt(
  outcome: "pending" | "exchanged" | "kernel_denied",
): void {
  expect(outcome).not.toBe("pending");
  if (outcome === "kernel_denied") expect(process.platform).toBe("win32");
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
    const firstLine = res.content.split("\n").find((l) => l.startsWith("1. "));
    expect(firstLine).toContain("src/payments/processor.ts");
    // metadata exposes the shortlist
    const top = res.metadata?.topFiles as string[] | undefined;
    expect(top?.[0]).toBe("src/payments/processor.ts");
  });

  it("never returns outside names or bytes after a final ancestor exchange", async () => {
    const workspace = join(dir, "workspace");
    const displaced = join(dir, "workspace-displaced");
    const outside = join(dir, "outside");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(outside, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "inside-orient.ts"),
      "export function confinementNeedle() { return 'inside-orient' }\n",
      "utf8",
    );
    await writeFile(
      join(outside, "src", "outside-secret.ts"),
      "export function confinementNeedle() { return 'outside-orient-secret' }\n",
      "utf8",
    );
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "orient-confinement-editor",
    });
    let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" = "pending";
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [workspace],
        __testAfterFinalPathCheck: async () => {
          exchangeOutcome = await exchangeDirectory(
            workspace,
            displaced,
            outside,
          );
        },
      }),
    );

    const result = await tool.execute({
      query: "confinementNeedle",
    });

    expectCompletedExchangeAttempt(exchangeOutcome);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inside-orient.ts");
    expect(result.content).not.toContain("outside-secret.ts");
    expect(result.content).not.toContain("outside-orient-secret");
  });

  it("keeps trusted Editor orientation bound after the live lease disappears", async () => {
    const workspace = join(dir, "workspace");
    const displaced = join(dir, "workspace-displaced");
    const outside = join(dir, "outside");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(outside, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "inside-trusted.ts"),
      "export function trustedOrientNeedle() { return 'inside-trusted-orient' }\n",
      "utf8",
    );
    await writeFile(
      join(outside, "src", "outside-trusted-secret.ts"),
      "export function trustedOrientNeedle() { return 'outside-trusted-orient-secret' }\n",
      "utf8",
    );
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "expired-orient-editor",
    });
    workspaceMutationCoordinators.clearForTests();
    let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" = "pending";
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [workspace],
        __testAfterFinalPathCheck: async () => {
          exchangeOutcome = await exchangeDirectory(
            workspace,
            displaced,
            outside,
          );
        },
      }),
    );
    const args: Record<string, unknown> = {
      query: "trustedOrientNeedle",
    };
    attachTrustedEditorContext(args);

    const result = await tool.execute(args);

    expectCompletedExchangeAttempt(exchangeOutcome);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inside-trusted.ts");
    expect(result.content).not.toContain("outside-trusted-secret.ts");
    expect(result.content).not.toContain("outside-trusted-orient-secret");
  });

  it("drops intermediate-swap names and bytes restored before file reads", async () => {
    const workspace = join(dir, "workspace");
    const source = join(workspace, "src");
    const outside = join(dir, "outside-source");
    const fakeRipgrepScript = join(dir, "orient-swap-rg.mjs");
    const fakeRipgrep =
      process.platform === "win32"
        ? join(dir, "orient-swap-rg.cmd")
        : fakeRipgrepScript;
    await mkdir(source, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(source, "inside.ts"),
      "export function insideOrient() { return 'inside' }\n",
      "utf8",
    );
    await writeFile(
      join(outside, "outside-secret.ts"),
      "export function outsideSecret() { return 'outside-orient-secret' }\n",
      "utf8",
    );
    await writeFile(
      fakeRipgrepScript,
      `#!${process.execPath}
import { rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
const source = join(process.cwd(), "src");
const displaced = join(process.cwd(), "src-inside");
try {
  await rename(source, displaced);
} catch (error) {
  if (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code)) process.exit(0);
  throw error;
}
try {
  await symlink(${JSON.stringify(outside)}, source, process.platform === "win32" ? "junction" : "dir");
} catch (error) {
  await rename(displaced, source).catch(() => {});
  if (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code)) process.exit(0);
  throw error;
}
process.stdout.write("src/outside-secret.ts\\n");
await unlink(source);
await rename(displaced, source);
`,
      "utf8",
    );
    if (process.platform === "win32") {
      await writeFile(
        fakeRipgrep,
        `@echo off\r\n"${process.execPath}" "${fakeRipgrepScript}" %*\r\n`,
        "utf8",
      );
    }
    await chmod(fakeRipgrep, 0o755);
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "orient-intermediate-editor",
    });
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [workspace],
        ripgrepCommand: fakeRipgrep,
      }),
    );

    const result = await tool.execute({ query: "outsideSecret" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No readable source files");
    expect(result.content).not.toContain("outside-secret.ts");
    expect(result.content).not.toContain("outside-orient-secret");
  });

  it("ignores generated/vendored dirs (node_modules) during enumeration", async () => {
    const res = await orient().execute({ query: "processRefund" });
    expect(res.content).not.toContain("node_modules");
  });

  it("never resolves the production ripgrep binary through PATH", async () => {
    const bin = join(dir, "bin");
    const marker = join(dir, "path-rg-ran");
    const fakeRipgrep = join(bin, "rg");
    await mkdir(bin);
    await writeFile(
      fakeRipgrep,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 99\n`,
      "utf8",
    );
    await chmod(fakeRipgrep, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = bin;

    try {
      const res = await orient().execute({ query: "processRefund" });

      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("src/payments/processor.ts");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
    }
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
    const res = await orient().execute({
      query: "reconcileLedger",
      path: "src/ledger",
    });
    expect(res.isError).toBeFalsy();
    // paths are relative to the scoped dir, so just the basename appears
    expect(res.content).toContain("reconcile.ts");
    // a file outside the scoped subdir must not appear
    expect(res.content).not.toContain("processor.ts");
  });

  it("builds its map from unsaved Editor bytes instead of stale disk content", async () => {
    const path = join(dir, "src", "authoritative.ts");
    await write(
      "src/authoritative.ts",
      "export function staleDiskSymbol() { return false }\n",
    );
    await establishDirtyEditorSnapshot({
      path,
      content: "export function unsavedEditorSymbol() { return true }\n",
    });

    const res = await orient().execute({
      query: "where is `unsavedEditorSymbol` defined",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("src/authoritative.ts");
    expect(res.content).toContain("unsavedEditorSymbol");
    expect(res.content).not.toContain("staleDiskSymbol");
  });

  it("discovers a source file that exists only as a dirty named Editor buffer", async () => {
    const path = join(dir, "src", "unsaved-only.ts");
    await establishDirtyEditorSnapshot({
      path,
      content: "export function dirtyOnlyOrientationSymbol() { return 42 }\n",
    });

    const res = await orient().execute({
      query: "locate `dirtyOnlyOrientationSymbol`",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("src/unsaved-only.ts");
    expect(res.content).toContain("dirtyOnlyOrientationSymbol");
    expect(res.metadata?.topFiles).toContain("src/unsaved-only.ts");
  });

  it("does not expose a dirty-only source path excluded by workspace ignore rules", async () => {
    await write(".gitignore", "src/private.ts\n");
    const path = join(dir, "src", "private.ts");
    await establishDirtyEditorSnapshot({
      path,
      content:
        "export function ignoredDirtyOrientationSymbol() { return 42 }\n",
    });

    const res = await orient().execute({
      query: "locate `ignoredDirtyOrientationSymbol`",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain("src/private.ts");
    expect(res.metadata?.topFiles).not.toContain("src/private.ts");
  });

  it("fails closed instead of orienting over disk when Editor authority is stale", async () => {
    const path = join(dir, "src", "stale.ts");
    await write(
      "src/stale.ts",
      "export function staleDiskOrientationSymbol() { return 1 }\n",
    );
    const { coordinator, lease } = await establishDirtyEditorSnapshot({
      path,
      content: "export function unsavedOrientationSymbol() { return 2 }\n",
    });
    await coordinator.release({
      workspaceRoot: dir,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    });

    const res = await orient().execute({
      query: "staleDiskOrientationSymbol",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/authoritative Editor workspace|reconnect/iu);
    expect(res.content).not.toContain("staleDiskOrientationSymbol()");
  });

  it("rejects the map when an authoritative Editor revision changes before return", async () => {
    const path = join(dir, "src", "racing.ts");
    await write("src/racing.ts", "export const diskValue = 1\n");
    const { coordinator, lease } = await establishDirtyEditorSnapshot({
      path,
      content: "export function firstOrientationRevision() { return 1 }\n",
    });
    let changed = false;
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [dir],
        beforeAuthoritativeSnapshotValidation: async () => {
          if (changed) return;
          changed = true;
          const next =
            "export function secondOrientationRevision() { return 2 }\n";
          coordinator.sync({
            workspaceRoot: dir,
            editorInstanceId: lease.editorInstanceId,
            leaseToken: lease.leaseToken,
            epoch: lease.epoch,
            sequence: 1,
            buffers: [
              {
                path,
                bufferHandle: 7,
                changedtick: 42,
                contentSha256: sha256(next),
                dirty: true,
                content: next,
              },
            ],
          });
          await coordinator.flushQuarantinePersistence();
        },
      }),
    );

    const res = await tool.execute({
      query: "firstOrientationRevision",
    });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/changed while orientation|synchronization/iu);
    expect(res.content).not.toContain("firstOrientationRevision()");
  });
});

async function establishDirtyEditorSnapshot({
  path,
  content,
}: {
  readonly path: string;
  readonly content: string;
}): Promise<{
  readonly coordinator: WorkspaceMutationCoordinator;
  readonly lease: WorkspaceEditorLease;
}> {
  const coordinator = workspaceMutationCoordinators.getOrCreate(dir);
  const lease = coordinator.acquire({
    workspaceRoot: dir,
    editorInstanceId: "orient-editor",
  });
  coordinator.sync({
    workspaceRoot: dir,
    editorInstanceId: lease.editorInstanceId,
    leaseToken: lease.leaseToken,
    epoch: lease.epoch,
    sequence: 0,
    buffers: [
      {
        path,
        bufferHandle: 7,
        changedtick: 41,
        contentSha256: sha256(content),
        dirty: true,
        content,
      },
    ],
  });
  await coordinator.flushQuarantinePersistence();
  return { coordinator, lease };
}
