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

async function createNodeExecutable(
  name: string,
  body: string,
): Promise<string> {
  const script = join(dir, `${name}.mjs`);
  const executable =
    process.platform === "win32" ? join(dir, `${name}.cmd`) : script;
  await writeFile(script, `#!${process.execPath}\n${body}\n`, "utf8");
  if (process.platform === "win32") {
    await writeFile(
      executable,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      "utf8",
    );
  }
  await chmod(executable, 0o755);
  return executable;
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
    sandboxMode: "danger_full_access",
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

  it("marks the file cap only when an N+1 witness exists", async () => {
    const runCase = async (
      name: string,
      fileCount: number,
      includeDirtyOnly = false,
    ): Promise<ToolResult> => {
      const workspace = join(dir, name);
      await mkdir(workspace);
      const paths = Array.from(
        { length: fileCount },
        (_, index) => `witness-${index}.ts`,
      );
      for (const path of paths) {
        await writeFile(
          join(workspace, path),
          `export const capWitness${path.length} = true;\n`,
          "utf8",
        );
      }
      if (includeDirtyOnly) {
        const dirtyContent =
          "export function dirtyOnlyCapWitness() { return true; }\n";
        const coordinator =
          workspaceMutationCoordinators.getOrCreate(workspace);
        const lease = coordinator.acquire({
          workspaceRoot: workspace,
          editorInstanceId: `${name}-editor`,
        });
        coordinator.sync({
          workspaceRoot: workspace,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 0,
          buffers: [
            {
              path: join(workspace, "dirty-only.ts"),
              bufferHandle: 1,
              changedtick: 1,
              contentSha256: sha256(dirtyContent),
              dirty: true,
              content: dirtyContent,
            },
          ],
        });
      }
      const fakeRipgrep = await createNodeExecutable(
        `${name}-rg`,
        `process.stdout.write(${JSON.stringify(`${paths.join("\0")}\0`)});`,
      );
      const tool = bindExplicitDangerBoundary(
        createOrientTool({
          allowedPaths: [workspace],
          ripgrepCommand: fakeRipgrep,
        }),
      );
      return tool.execute({ query: "capWitness", maxFiles: 2 });
    };

    const exact = await runCase("exact-cap", 2);
    const truncated = await runCase("over-cap", 3);
    const combined = await runCase("combined-cap", 2, true);

    expect(exact.isError).toBeUndefined();
    expect(exact.metadata?.fileCount).toBe(2);
    expect(exact.content).not.toContain("(capped at 2)");
    expect(truncated.isError).toBeUndefined();
    expect(truncated.metadata?.fileCount).toBe(2);
    expect(truncated.content).toContain("(capped at 2)");
    expect(combined.isError).toBeUndefined();
    expect(combined.metadata?.fileCount).toBe(2);
    expect(combined.metadata?.topFiles).toContain("dirty-only.ts");
    expect(combined.content).toContain("(capped at 2)");
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

  it("rejects stale disk bytes when a dirty workspace path is exchanged", async () => {
    const workspace = join(dir, "dirty-workspace");
    const displaced = join(dir, "dirty-workspace-displaced");
    const outside = join(dir, "dirty-workspace-outside");
    const path = join(workspace, "inside.ts");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(
      path,
      "export function staleDiskNeedle() { return false }\n",
      "utf8",
    );
    await writeFile(
      join(outside, "outside.ts"),
      "export function outsideNeedle() { return false }\n",
      "utf8",
    );
    const authoritativeContent =
      "export function authoritativeNeedle() { return true }\n";
    const coordinator = workspaceMutationCoordinators.getOrCreate(workspace);
    const lease = coordinator.acquire({
      workspaceRoot: workspace,
      editorInstanceId: "orient-dirty-exchange-editor",
    });
    coordinator.sync({
      workspaceRoot: workspace,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 1,
          contentSha256: sha256(authoritativeContent),
          dirty: true,
          content: authoritativeContent,
        },
      ],
    });
    let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" =
      "pending";
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

    const result = await tool.execute({ query: "authoritativeNeedle" });

    expectCompletedExchangeAttempt(exchangeOutcome);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("authoritativeNeedle");
    expect(result.content).not.toContain("staleDiskNeedle");
    expect(result.content).not.toContain("outsideNeedle");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a clean Editor lease that becomes dirty across a later path exchange",
    async () => {
      const workspace = join(dir, "late-dirty-workspace");
      const displaced = join(dir, "late-dirty-workspace-displaced");
      const outside = join(dir, "late-dirty-workspace-outside");
      const path = join(workspace, "inside.ts");
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(
        path,
        "export function staleLateDiskNeedle() { return false }\n",
        "utf8",
      );
      await writeFile(
        join(outside, "outside.ts"),
        "export function outsideLateNeedle() { return false }\n",
        "utf8",
      );
      const coordinator = workspaceMutationCoordinators.getOrCreate(workspace);
      const lease = coordinator.acquire({
        workspaceRoot: workspace,
        editorInstanceId: "orient-late-dirty-editor",
      });
      let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" =
        "pending";
      const tool = bindExplicitDangerBoundary(
        createOrientTool({
          allowedPaths: [workspace],
          __testAfterRootIgnoreSnapshot: async () => {
            const authoritativeContent =
              "export function authoritativeLateNeedle() { return true }\n";
            coordinator.sync({
              workspaceRoot: workspace,
              editorInstanceId: lease.editorInstanceId,
              leaseToken: lease.leaseToken,
              epoch: lease.epoch,
              sequence: 0,
              buffers: [
                {
                  path,
                  bufferHandle: 1,
                  changedtick: 1,
                  contentSha256: sha256(authoritativeContent),
                  dirty: true,
                  content: authoritativeContent,
                },
              ],
            });
            exchangeOutcome = await exchangeDirectory(
              workspace,
              displaced,
              outside,
            );
          },
        }),
      );

      const result = await tool.execute({ query: "Needle" });

      expect(exchangeOutcome).toBe("exchanged");
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/changed while orientation|synchronization/iu);
      expect(result.content).not.toContain("staleLateDiskNeedle");
      expect(result.content).not.toContain("outsideLateNeedle");
    },
  );

  it("includes nested Editor authority and fences sibling acquisition", async () => {
    const workspace = join(dir, "parent-scan");
    const nested = join(workspace, "nested");
    const sibling = join(workspace, "sibling");
    const path = join(nested, "inside.ts");
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);
    await writeFile(
      path,
      "export function staleNestedDiskNeedle() { return false }\n",
      "utf8",
    );
    const authoritativeContent =
      "export function authoritativeNestedNeedle() { return true }\n";
    const coordinator = workspaceMutationCoordinators.getOrCreate(nested);
    const lease = coordinator.acquire({
      workspaceRoot: nested,
      editorInstanceId: "orient-nested-editor",
    });
    coordinator.sync({
      workspaceRoot: nested,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      sequence: 0,
      buffers: [
        {
          path,
          bufferHandle: 1,
          changedtick: 1,
          contentSha256: sha256(authoritativeContent),
          dirty: true,
          content: authoritativeContent,
        },
      ],
    });
    let lateAcquireError: unknown;
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [workspace],
        __testAfterRootIgnoreSnapshot: () => {
          try {
            workspaceMutationCoordinators.acquireEditor(sibling, {
              workspaceRoot: sibling,
              editorInstanceId: "orient-sibling-late-editor",
            });
          } catch (error) {
            lateAcquireError = error;
          }
        },
      }),
    );

    const result = await tool.execute({ query: "authoritativeNestedNeedle" });

    expect((lateAcquireError as { code?: unknown })?.code).toBe(
      "EDITOR_LEASE_CONFLICT",
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("nested/inside.ts");
    expect(result.content).toContain("authoritativeNestedNeedle");
    expect(result.content).not.toContain("staleNestedDiskNeedle");
    const postToolLease = workspaceMutationCoordinators.acquireEditor(sibling, {
      workspaceRoot: sibling,
      editorInstanceId: "orient-sibling-post-editor",
    });
    expect(postToolLease.editorInstanceId).toBe(
      "orient-sibling-post-editor",
    );
  });

  it.runIf(process.platform !== "win32")(
    "holds an Editor-acquisition fence across final read seams",
    async () => {
      for (const seam of ["final-path", "root-ignore"] as const) {
        const workspace = join(dir, `late-authority-${seam}`);
        const displaced = join(dir, `late-authority-${seam}-displaced`);
        const outside = join(dir, `late-authority-${seam}-outside`);
        await mkdir(workspace);
        await mkdir(outside);
        await writeFile(
          join(workspace, "inside.ts"),
          "export function insideLateAuthority() { return 'inside' }\n",
          "utf8",
        );
        await writeFile(
          join(outside, "outside-secret.ts"),
          "export function outsideLateAuthoritySecret() { return 'outside-orient-secret' }\n",
          "utf8",
        );
        let lateAcquireError: unknown;
        let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" =
          "pending";
        const attemptLateAuthority = async (): Promise<void> => {
          exchangeOutcome = await exchangeDirectory(
            workspace,
            displaced,
            outside,
          );
          try {
            workspaceMutationCoordinators.acquireEditor(workspace, {
              workspaceRoot: workspace,
              editorInstanceId: `orient-late-${seam}`,
            });
          } catch (error) {
            lateAcquireError = error;
          }
        };
        const tool = bindExplicitDangerBoundary(
          createOrientTool({
            allowedPaths: [workspace],
            ...(seam === "final-path"
              ? { __testAfterFinalPathCheck: attemptLateAuthority }
              : { __testAfterRootIgnoreSnapshot: attemptLateAuthority }),
          }),
        );

        const result = await tool.execute({ query: "insideLateAuthority" });

        expect((lateAcquireError as { code?: unknown })?.code).toBe(
          "EDITOR_LEASE_CONFLICT",
        );
        expectCompletedExchangeAttempt(exchangeOutcome);
        expect(result.isError).toBeUndefined();
        expect(result.content).toContain("inside.ts");
        expect(result.content).not.toContain("outside-secret.ts");
        expect(result.content).not.toContain("outsideLateAuthoritySecret");
        const postToolLease = workspaceMutationCoordinators.acquireEditor(
          workspace,
          {
            workspaceRoot: workspace,
            editorInstanceId: `orient-post-${seam}`,
          },
        );
        expect(postToolLease.editorInstanceId).toBe(`orient-post-${seam}`);
      }
    },
  );

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
process.stdout.write("src/outside-secret.ts\\0");
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

  it("fails closed when file enumeration times out", async () => {
    const fakeRipgrep = await createNodeExecutable(
      "orient-timeout-rg",
      "setTimeout(() => process.stdout.write('src/late.ts\\0'), 1_000);",
    );
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [dir],
        ripgrepCommand: fakeRipgrep,
        __testRipgrepTimeoutMs: 20,
      }),
    );

    const result = await tool.execute({ query: "processRefund" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ripgrep timed out");
    expect(result.content).not.toContain("Orientation map for");
  });

  it("fails closed when file enumeration exceeds its output ceiling", async () => {
    const fakeRipgrep = await createNodeExecutable(
      "orient-output-rg",
      "process.stderr.write('x'.repeat(4_096)); setTimeout(() => {}, 1_000);",
    );
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [dir],
        ripgrepCommand: fakeRipgrep,
        __testRipgrepMaxOutputBytes: 32,
      }),
    );

    const result = await tool.execute({ query: "processRefund" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("output safety limit");
    expect(result.content).not.toContain("Orientation map for");
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

  it("scoped maps honor root ignore rules in clean and protected workspaces", async () => {
    await write(".gitignore", "src/private/ignored.ts\n");
    await write(
      "src/private/visible.ts",
      "export function visibleScopedOrientation() { return 1 }\n",
    );
    await write(
      "src/private/ignored.ts",
      "export function ignoredScopedOrientation() { return 2 }\n",
    );
    const tool = bindExplicitDangerBoundary(
      createOrientTool({ allowedPaths: [dir] }),
    );

    const clean = await tool.execute({
      query: "visibleScopedOrientation ignoredScopedOrientation",
      path: "src/private",
    });
    expect(clean.isError).toBeFalsy();
    expect(clean.content).toContain("visible.ts");
    expect(clean.content).not.toContain("ignored.ts");

    workspaceMutationCoordinators.getOrCreate(dir).acquire({
      workspaceRoot: dir,
      editorInstanceId: "orient-ignore-editor",
    });
    const protectedResult = await tool.execute({
      query: "visibleScopedOrientation ignoredScopedOrientation",
      path: "src/private",
    });
    expect(protectedResult.isError).toBeFalsy();
    expect(protectedResult.content).toContain("visible.ts");
    expect(protectedResult.content).not.toContain("ignored.ts");
  });

  it.runIf(process.platform !== "win32")(
    "uses snapshotted root ignore bytes after the admitted pathname becomes a symlink",
    async () => {
      const ignorePath = join(dir, ".gitignore");
      const admittedPath = join(dir, ".gitignore-admitted");
      const replacementPath = join(dir, "replacement.ignore");
      await write(".gitignore", "src/private/ignored-snapshot.ts\n");
      await write("replacement.ignore", "!src/private/ignored-snapshot.ts\n");
      await write(
        "src/private/ignored-snapshot.ts",
        "export function ignoredSnapshotOrientation() { return 7 }\n",
      );
      await write(
        "src/private/visible-snapshot.ts",
        "export function visibleSnapshotOrientation() { return 8 }\n",
      );

      const run = async (editorProtected: boolean) => {
        if (editorProtected) {
          workspaceMutationCoordinators.getOrCreate(dir).acquire({
            workspaceRoot: dir,
            editorInstanceId: "orient-ignore-snapshot-editor",
          });
        }
        let exchanged = false;
        const tool = bindExplicitDangerBoundary(
          createOrientTool({
            allowedPaths: [dir],
            __testAfterRootIgnoreSnapshot: async () => {
              await rename(ignorePath, admittedPath);
              await symlink(replacementPath, ignorePath, "file");
              exchanged = true;
            },
          }),
        );

        const result = await tool.execute({
          query: "visibleSnapshotOrientation ignoredSnapshotOrientation",
          path: "src/private",
        });

        expect(exchanged).toBe(true);
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain("visible-snapshot.ts");
        expect(result.content).not.toContain("ignored-snapshot.ts");
        await rm(ignorePath, { force: true });
        await rename(admittedPath, ignorePath);
      };

      await run(false);
      await run(true);
    },
  );

  it("rejects a scoped directory exchanged between admission and binding", async () => {
    const workspace = join(dir, "prebind-workspace");
    const scoped = join(workspace, "src");
    const displaced = join(workspace, "src-displaced");
    const outside = join(dir, "prebind-outside");
    await mkdir(scoped, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(scoped, "inside.ts"),
      "export function insidePrebindOrientation() { return 1 }\n",
      "utf8",
    );
    await writeFile(
      join(outside, "outside-secret.ts"),
      "export function outsidePrebindSecret() { return 2 }\n",
      "utf8",
    );
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "orient-prebind-editor",
    });
    let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" = "pending";
    const tool = bindExplicitDangerBoundary(
      createOrientTool({
        allowedPaths: [workspace],
        __testBeforeReadCapabilityBind: async () => {
          exchangeOutcome = await exchangeDirectory(scoped, displaced, outside);
        },
      }),
    );

    const result = await tool.execute({
      query: "insidePrebindOrientation outsidePrebindSecret",
      path: scoped,
    });

    expectCompletedExchangeAttempt(exchangeOutcome);
    if (exchangeOutcome === "exchanged") {
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/cannot be read safely|identity/iu);
    }
    expect(result.content).not.toContain("outside-secret.ts");
    expect(result.content).not.toContain("outsidePrebindSecret");
  });

  it.runIf(process.platform !== "win32")(
    "keeps platform-distinct POSIX dirty source identities separate",
    async () => {
      const fixtures = [
        ...(process.platform === "linux"
          ? [
              {
                path: join(dir, "src", "caf\u00e9.ts"),
                relativePath: "src/caf\u00e9.ts",
                symbol: "nfcOrientationIdentity",
              },
              {
                path: join(dir, "src", "cafe\u0301.ts"),
                relativePath: "src/cafe\u0301.ts",
                symbol: "nfdOrientationIdentity",
              },
            ]
          : []),
        {
          path: join(dir, "src", "literal\\name.ts"),
          relativePath: "src/literal\\name.ts",
          symbol: "backslashOrientationIdentity",
        },
      ] as const;
      for (const fixture of fixtures) {
        await writeFile(
          fixture.path,
          "export const staleDisk = true;\n",
          "utf8",
        );
      }
      const coordinator = workspaceMutationCoordinators.getOrCreate(dir);
      const lease = coordinator.acquire({
        workspaceRoot: dir,
        editorInstanceId: "orient-posix-identity-editor",
      });
      coordinator.sync({
        workspaceRoot: dir,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: fixtures.map((fixture, index) => {
          const content = `export function ${fixture.symbol}() { return ${index}; }\n`;
          return {
            path: fixture.path,
            bufferHandle: index + 1,
            changedtick: 1,
            contentSha256: sha256(content),
            dirty: true,
            content,
          };
        }),
      });

      for (const fixture of fixtures) {
        const result = await orient().execute({
          query: `locate \`${fixture.symbol}\``,
        });
        expect(result.isError).toBeFalsy();
        expect(result.metadata?.topFiles).toContain(fixture.relativePath);
        expect(result.content).toContain(fixture.symbol);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not suppress a normalization-sensitive Darwin dirty sibling",
    async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor?.configurable !== true) {
        throw new Error("process.platform is not configurable for this test");
      }
      const workspace = join(dir, "darwin-sensitive-workspace");
      const nfcName = "caf\u00e9.ts";
      const nfdName = "cafe\u0301.ts";
      await mkdir(workspace);
      await writeFile(
        join(workspace, nfcName),
        "export function staleNfcDarwinValue() { return false; }\n",
        "utf8",
      );
      await writeFile(
        join(workspace, nfdName),
        "export function nfdDarwinSibling() { return true; }\n",
        "utf8",
      );
      await writeFile(
        join(workspace, "other.ts"),
        "export function otherDarwinCandidate() { return true; }\n",
        "utf8",
      );
      const fakeRipgrep = await createNodeExecutable(
        "orient-darwin-sensitive-rg",
        `process.stdout.write(${JSON.stringify(`${nfdName}\0other.ts\0`)});`,
      );
      const tool = bindExplicitDangerBoundary(
        createOrientTool({
          allowedPaths: [workspace],
          ripgrepCommand: fakeRipgrep,
        }),
      );
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      const result = await (async (): Promise<ToolResult> => {
        try {
          const dirtyContent =
            "export function authoritativeNfcDarwinValue() { return true; }\n";
          const coordinator =
            workspaceMutationCoordinators.getOrCreate(workspace);
          const lease = coordinator.acquire({
            workspaceRoot: workspace,
            editorInstanceId: "orient-darwin-sensitive-editor",
          });
          coordinator.sync({
            workspaceRoot: workspace,
            editorInstanceId: lease.editorInstanceId,
            leaseToken: lease.leaseToken,
            epoch: lease.epoch,
            sequence: 0,
            buffers: [
              {
                path: join(workspace, nfcName),
                bufferHandle: 1,
                changedtick: 1,
                contentSha256: sha256(dirtyContent),
                dirty: true,
                content: dirtyContent,
              },
            ],
          });
          return await tool.execute({
            query:
              "authoritativeNfcDarwinValue nfdDarwinSibling otherDarwinCandidate",
            maxFiles: 3,
          });
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      })();

      expect(result.isError).toBeUndefined();
      expect(result.metadata?.fileCount).toBe(3);
      expect(result.metadata?.topFiles).toContain(nfcName);
      expect(result.metadata?.topFiles).toContain(nfdName);
      expect(result.metadata?.topFiles).toContain("other.ts");
      expect(result.content).toContain("authoritativeNfcDarwinValue");
      expect(result.content).toContain("nfdDarwinSibling");
      expect(result.content).not.toContain("staleNfcDarwinValue");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips newline and invalid UTF-8 paths without inventing orientation rows",
    async () => {
      const newlinePath = Buffer.from(join(dir, "src", "line\nname.ts"));
      const invalidPath =
        process.platform === "linux"
          ? Buffer.concat([
              Buffer.from(`${join(dir, "src", "invalid-")}`, "utf8"),
              Buffer.from([0xff]),
              Buffer.from(".ts", "utf8"),
            ])
          : undefined;
      await writeFile(
        newlinePath,
        "export function newlinePathSecret() { return 1 }\n",
      );
      if (invalidPath !== undefined) {
        await writeFile(
          invalidPath,
          "export function invalidPathSecret() { return 2 }\n",
        );
      }
      workspaceMutationCoordinators.getOrCreate(dir).acquire({
        workspaceRoot: dir,
        editorInstanceId: "orient-byte-path-editor",
      });

      const result = await orient().execute({
        query: "processRefund newlinePathSecret invalidPathSecret",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("src/payments/processor.ts");
      expect(result.content).not.toContain("line\nname.ts");
      const symbolMap = result.content.split("Key symbols by file:")[1] ?? "";
      expect(symbolMap).not.toContain("newlinePathSecret");
      expect(symbolMap).not.toContain("invalidPathSecret");
      expect(result.content).not.toContain("invalid-");
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits control-bearing dirty paths without hiding valid dirty sources",
    async () => {
      const fixtures = [
        { name: "dirty\nnewline.ts", symbol: "dirtyNewlineSecret" },
        { name: "dirty\rcarriage.ts", symbol: "dirtyCarriageSecret" },
        { name: "dirty\ttab.ts", symbol: "dirtyTabSecret" },
        { name: "valid-dirty.ts", symbol: "validDirtyOrientation" },
      ] as const;
      const coordinator = workspaceMutationCoordinators.getOrCreate(dir);
      const lease = coordinator.acquire({
        workspaceRoot: dir,
        editorInstanceId: "orient-dirty-control-editor",
      });
      coordinator.sync({
        workspaceRoot: dir,
        editorInstanceId: lease.editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: fixtures.map((fixture, index) => {
          const content = `export function ${fixture.symbol}() { return ${index}; }\n`;
          return {
            path: join(dir, "src", fixture.name),
            bufferHandle: index + 1,
            changedtick: 1,
            contentSha256: sha256(content),
            dirty: true,
            content,
          };
        }),
      });

      const result = await orient().execute({
        query:
          "validDirtyOrientation dirtyNewlineSecret dirtyCarriageSecret dirtyTabSecret",
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("src/valid-dirty.ts");
      expect(result.content).toContain("validDirtyOrientation");
      const symbolMap = result.content.split("Key symbols by file:")[1] ?? "";
      expect(symbolMap).not.toContain("dirtyNewlineSecret");
      expect(symbolMap).not.toContain("dirtyCarriageSecret");
      expect(symbolMap).not.toContain("dirtyTabSecret");
    },
  );

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
