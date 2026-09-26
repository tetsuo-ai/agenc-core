import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSignedAllowedRoots } from "../../src/agents/_deps/filesystem-args.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { worktreeWriteRefusal } from "../../src/agents/worktree-write-confinement.js";
import type { Session } from "../../src/session/session.js";
import type { Tool, ToolRegistry } from "../../src/tools/types.js";

// Goal E2E 2026-09-25, run wf-97c581d7 (DeepSeek, "Ask for every tool"): the
// Goal's implement step ran in its worktree <checkout>/.agenc-worktrees/m5-wf97c581d76f,
// found it empty, and called Write on <checkout>/src/slug.js and
// <checkout>/test/slug.test.js. Both were auto-approved under acceptEdits and
// written into the user's checkout, which the verified-change workflow
// promises never to touch: the child's file tools keep the parent's workspace
// root as an allowed root, and the worktree is only added to it.
let checkout: string;
let worktree: string;

beforeEach(() => {
  checkout = realpathSync(mkdtempSync(join(tmpdir(), "agenc-worktree-confine-")));
  worktree = join(checkout, ".agenc-worktrees", "m5-wf97c581d76f");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(checkout, "src"), { recursive: true });
});
afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe("worktreeWriteRefusal", () => {
  it("refuses a write into the checkout the worktree isolates", () => {
    const refusal = worktreeWriteRefusal("Write", { file_path: join(checkout, "src/slug.js"), content: "x" }, worktree);
    expect(refusal).toContain(`This agent works in its own git worktree (${worktree})`);
    expect(refusal).toContain(`${join(checkout, "src/slug.js")} is outside it`);
  });

  it("allows writes inside the worktree, relative or absolute", () => {
    expect(worktreeWriteRefusal("Write", { file_path: "src/slug.js", content: "x" }, worktree)).toBeUndefined();
    expect(worktreeWriteRefusal("Edit", { file_path: join(worktree, "src/slug.js") }, worktree)).toBeUndefined();
    expect(worktreeWriteRefusal("MultiEdit", { file_path: "src/new/deep/file.js", cwd: worktree }, worktree)).toBeUndefined();
  });

  it("refuses relative paths and working directories that lead out", () => {
    expect(worktreeWriteRefusal("Write", { file_path: "../../src/slug.js" }, worktree)).toBeDefined();
    expect(worktreeWriteRefusal("Edit", { file_path: "src/slug.js", cwd: checkout }, worktree)).toBeDefined();
    expect(worktreeWriteRefusal("NotebookEdit", { notebook_path: join(checkout, "a.ipynb") }, worktree)).toBeDefined();
  });

  it("follows a link inside the worktree that points back into the checkout", () => {
    symlinkSync(join(checkout, "src"), join(worktree, "linked"));
    expect(worktreeWriteRefusal("Write", { file_path: "linked/slug.js" }, worktree)).toBeDefined();
  });

  it("reads every path an apply_patch would write, including a move and a workdir", () => {
    const patch = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;
    expect(worktreeWriteRefusal("apply_patch", { input: patch("*** Add File: src/slug.js\n+export {};") }, worktree)).toBeUndefined();
    expect(worktreeWriteRefusal("apply_patch", { input: patch(`*** Add File: ${join(checkout, "src/slug.js")}\n+export {};`) }, worktree)).toBeDefined();
    expect(worktreeWriteRefusal("apply_patch", { input: patch("*** Add File: ../../src/slug.js\n+export {};") }, worktree)).toBeDefined();
  });

  it("allows a root a trusted child-tool policy signed into the call, such as a memory directory", () => {
    const memory = join(checkout, "memory-dir");
    mkdirSync(memory);
    const signed = withSignedAllowedRoots({ file_path: join(memory, "feedback.md"), content: "x" }, [memory]);
    expect(worktreeWriteRefusal("Write", signed, worktree)).toBeUndefined();
    // An unsigned claim is not a root.
    expect(worktreeWriteRefusal("Write", { file_path: join(checkout, "src/slug.js"), __agencSessionAllowedRoots: [checkout] }, worktree)).toBeDefined();
  });

  it("does not apply to reads, to other tools, or outside a worktree", () => {
    expect(worktreeWriteRefusal("FileRead", { file_path: join(checkout, "src/slug.js") }, worktree)).toBeUndefined();
    expect(worktreeWriteRefusal("exec_command", { cmd: "touch ../x" }, worktree)).toBeUndefined();
    expect(worktreeWriteRefusal("Write", { file_path: join(checkout, "src/slug.js") }, undefined)).toBeUndefined();
  });
});

describe("a worktree child's Write through the child registry", () => {
  function childRegistry(seen: Record<string, unknown>[]): Tool {
    const write = {
      name: "Write",
      description: "test write",
      inputSchema: { type: "object", properties: {} },
      // The parent's tool allows the checkout: its closure root is the checkout.
      checkPermissions: async (input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }),
      async execute(args: Record<string, unknown>) {
        seen.push(args);
        return { content: "written" };
      },
    } as unknown as Tool;
    const base = {
      tools: [write],
      toLLMTools: () => [{ type: "function", function: { name: "Write", description: "test write", parameters: {} } }],
    } as unknown as ToolRegistry;
    const session = {
      conversationId: "child-1",
      sessionConfiguration: { cwd: worktree, sandboxPolicy: { value: "workspace_write" } },
      permissionModeRegistry: { current: () => ({ mode: "acceptEdits", additionalWorkingDirectories: new Map() }) },
      services: {},
    } as unknown as Session;
    const registry = buildFilteredRegistry(base, {
      childConversationId: "child-1",
      worktree: { path: worktree, branch: "worktree-m5-wf97c581d76f", gitRoot: checkout } as never,
      getSession: () => session,
    });
    return registry.tools.find((tool) => tool.name === "Write")!;
  }

  it("is not a permission denial, which would end a whole Goal run", async () => {
    // A workflow child's denied approval is WorkflowApprovalFailure: the run
    // ends policy_denied. The refusal belongs to execution, as a tool error.
    const seen: Record<string, unknown>[] = [];
    const write = childRegistry(seen);
    const decision = await write.checkPermissions!({ file_path: join(checkout, "src/slug.js"), content: "x" }, {} as never);
    expect(decision.behavior).not.toBe("deny");
  });

  it("is refused at execution and never reaches the tool", async () => {
    const seen: Record<string, unknown>[] = [];
    const write = childRegistry(seen);
    const result = await write.execute({ file_path: join(checkout, "src/slug.js"), content: "x" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("is outside it");
    expect(seen).toEqual([]);
  });

  it("still writes inside the worktree", async () => {
    const seen: Record<string, unknown>[] = [];
    const write = childRegistry(seen);
    const decision = await write.checkPermissions!({ file_path: "src/slug.js", content: "x" }, {} as never);
    expect(decision.behavior).not.toBe("deny");
    await write.execute({ file_path: "src/slug.js", content: "x" });
    expect(seen).toHaveLength(1);
  });
});
