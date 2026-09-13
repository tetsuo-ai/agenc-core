import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  verifyAllowedRoots,
} from "../../src/agents/_deps/filesystem-args.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import type { Session } from "../../src/session/session.js";
import type { Tool, ToolRegistry } from "../../src/tools/types.js";

interface PermissionContextLike {
  readonly mode: string;
  readonly additionalWorkingDirectories: Map<string, { readonly path: string }>;
}

function fakeChildSession(
  context: PermissionContextLike,
  sandboxPolicy: Session["sessionConfiguration"]["sandboxPolicy"]["value"],
): Session {
  const registry = { current: () => context };
  const configuration = {
    cwd: "/repo",
    sandboxPolicy: { value: sandboxPolicy },
  } satisfies Pick<Session["sessionConfiguration"], "cwd" | "sandboxPolicy">;
  return {
    conversationId: "child-1",
    sessionConfiguration: configuration,
    permissionModeRegistry: registry,
    services: { permissionModeRegistry: registry },
  } as unknown as Session;
}

function recordingGlob(seen: Record<string, unknown>[]): Tool {
  return {
    name: "Glob",
    description: "test glob",
    inputSchema: { type: "object", properties: {} },
    async execute(args: Record<string, unknown>) {
      seen.push(args);
      return { content: "ok" };
    },
  } as unknown as Tool;
}

function verifiedRoots(args: Record<string, unknown>): string[] {
  return verifyAllowedRoots(
    args[SESSION_ALLOWED_ROOTS_ARG],
    args[SESSION_ALLOWED_ROOTS_SIG_ARG],
  );
}

describe("child tool calls widen filesystem roots like the parent dispatcher", () => {
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "agenc-child-roots-"));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  async function runGlob(session: Session): Promise<Record<string, unknown>> {
    const seen: Record<string, unknown>[] = [];
    const tool = recordingGlob(seen);
    const base = {
      tools: [tool],
      toLLMTools: () => [
        {
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: {} },
        },
      ],
    } as unknown as ToolRegistry;
    const registry = buildFilteredRegistry(base, {
      childConversationId: "child-1",
      getSession: () => session,
    });
    const glob = registry.tools.find((tool) => tool.name === "Glob");
    expect(glob).toBeDefined();
    await glob!.execute({ pattern: "*", path: outside });
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it("hands a subagent the search directory under the full bypass", async () => {
    // A subagent under --dangerously-bypass-approvals-and-sandbox was refused
    // on Glob /tmp while the parent searched it freely: only the parent's
    // dispatcher applied the widening.
    const args = await runGlob(
      fakeChildSession(
        { mode: "bypassPermissions", additionalWorkingDirectories: new Map() },
        "danger_full_access",
      ),
    );
    expect(verifiedRoots(args)).toContain(outside);
  });

  it("hands a subagent a directory inside one the user added", async () => {
    const args = await runGlob(
      fakeChildSession(
        {
          mode: "default",
          additionalWorkingDirectories: new Map([[tmpdir(), { path: tmpdir() }]]),
        },
        "workspace_write",
      ),
    );
    expect(verifiedRoots(args)).toContain(outside);
  });

  it("leaves the confinement alone when nothing allowed the path", async () => {
    const args = await runGlob(
      fakeChildSession(
        { mode: "default", additionalWorkingDirectories: new Map() },
        "workspace_write",
      ),
    );
    expect(verifiedRoots(args)).toEqual([]);
  });

  it("keeps workspace confinement when only approvals are bypassed", async () => {
    const args = await runGlob(
      fakeChildSession(
        { mode: "bypassPermissions", additionalWorkingDirectories: new Map() },
        "workspace_write",
      ),
    );
    expect(verifiedRoots(args)).toEqual([]);
  });

  it("does not substitute sandbox bypass for an unresolved approval", async () => {
    const args = await runGlob(
      fakeChildSession(
        { mode: "default", additionalWorkingDirectories: new Map() },
        "danger_full_access",
      ),
    );
    expect(verifiedRoots(args)).toEqual([]);
  });
});
