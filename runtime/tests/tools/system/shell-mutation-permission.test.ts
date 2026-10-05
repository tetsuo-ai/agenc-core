import { afterEach, describe, expect, test, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  shellAdditionalWriteRoots,
  shellBypassesApprovalsAndSandbox,
  shellDeletionProtectedRoots,
  shellFileWriteTools,
  shellWorkspaceMutationPermission,
} from "src/tools/system/shell-mutation-permission.js";
import type { ToolRuntimeAttemptContext } from "src/tools/runtimes/context.js";
import { attachToolRuntimeContext } from "src/tools/runtimes/context.js";
import { SHELL_FILE_WRITE_TOOL_NAMES } from "src/llm/shell-write-policy.js";
import {
  FILE_EDIT_TOOL_NAME,
  FILE_MULTI_EDIT_TOOL_NAME,
} from "src/tools/system/file-edit.js";
import { FILE_WRITE_TOOL_NAME } from "src/tools/system/file-write.js";
import { APPLY_PATCH_TOOL_NAME } from "src/tools/apply-patch/tool.js";
import {
  buildFilteredRegistry,
  mergeRoleDisallowlist,
} from "src/agents/run-agent.js";
import { BUILTIN_READONLY_DISALLOWLIST } from "src/agents/built-in-prompts.js";
import { buildToolRegistry, type ToolRegistry } from "src/tool-registry.js";

describe("shell deletion protected roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("protects the configured home when there is no session to ask", () => {
    // The guard runs for bare tool use too, where no session and therefore no
    // ConfigStore exists. It must still name the home directory a shell
    // command may not remove.
    vi.stubEnv("AGENC_HOME", "/srv/agenc-home");

    expect(shellDeletionProtectedRoots(undefined)).toContain(
      resolve("/srv/agenc-home"),
    );
  });

  test("protects the platform default home when the variable is unset", () => {
    // Reading AGENC_HOME directly left this case unguarded: with the variable
    // unset the home is <platform home>/.agenc, and a raw env read contributes
    // nothing at all. Resolving through the canonical home authority is what
    // closes that gap.
    vi.stubEnv("AGENC_HOME", "");

    expect(shellDeletionProtectedRoots(undefined)).toContain(
      resolve(join(homedir(), ".agenc")),
    );
  });
});

function runtimeContext(params: {
  readonly sandboxMode: string;
  readonly approvalPolicy: string;
  readonly mode?: string;
  readonly additionalWorkingDirectories?: ReadonlyMap<string, { readonly path: string; readonly source: string }>;
}): ToolRuntimeAttemptContext {
  return {
    approvalPolicy: params.approvalPolicy,
    sandboxMode: params.sandboxMode,
    approvalResolved: false,
    invocation: {
      session: {
        permissionModeRegistry: {
          current: () => ({
            mode: params.mode ?? "default",
            additionalWorkingDirectories:
              params.additionalWorkingDirectories ?? new Map(),
          }),
        },
      },
    },
  } as unknown as ToolRuntimeAttemptContext;
}

describe("shellBypassesApprovalsAndSandbox", () => {
  test("is true only when the session never asks and runs without a sandbox", () => {
    expect(
      shellBypassesApprovalsAndSandbox(
        runtimeContext({ sandboxMode: "danger_full_access", approvalPolicy: "never" }),
      ),
    ).toBe(true);
    // --dangerously-bypass-approvals-and-sandbox selects bypassPermissions; the
    // arbiter short-circuits on the mode, so the policy must read it too.
    expect(
      shellBypassesApprovalsAndSandbox(
        runtimeContext({
          sandboxMode: "danger_full_access",
          approvalPolicy: "on_request",
          mode: "bypassPermissions",
        }),
      ),
    ).toBe(true);
  });

  test("is false while either a prompt or a sandbox still gates the command", () => {
    // --bypass-approvals: prompts off, sandbox on.
    expect(
      shellBypassesApprovalsAndSandbox(
        runtimeContext({ sandboxMode: "workspace_write", approvalPolicy: "never" }),
      ),
    ).toBe(false);
    // A prompting session that happens to run without a sandbox.
    expect(
      shellBypassesApprovalsAndSandbox(
        runtimeContext({ sandboxMode: "danger_full_access", approvalPolicy: "on_request" }),
      ),
    ).toBe(false);
    expect(shellBypassesApprovalsAndSandbox(undefined)).toBe(false);
  });
});

describe("shellAdditionalWriteRoots", () => {
  test("reads the directories the user added, from the command line or during the session", () => {
    const roots = shellAdditionalWriteRoots(
      runtimeContext({
        sandboxMode: "workspace_write",
        approvalPolicy: "on_request",
        additionalWorkingDirectories: new Map([
          ["/srv/added", { path: "/srv/added", source: "cliArg" }],
          ["/srv/session", { path: "/srv/session/", source: "session" }],
        ]),
      }),
    );
    expect(roots).toEqual([resolve("/srv/added"), resolve("/srv/session")]);
  });

  test("is empty without a session", () => {
    expect(shellAdditionalWriteRoots(undefined)).toEqual([]);
  });
});

describe("shellFileWriteTools", () => {
  /** A registry holding `names` that lists `listed` (all of them by default) to the model. */
  function registryOf(
    names: readonly string[],
    unavailable: readonly string[] = [],
    listed: readonly string[] = names,
  ): ToolRegistry {
    const tools = names.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" } as const,
      execute: async () => ({ content: "{}" }),
    }));
    return {
      tools,
      toLLMTools: () =>
        tools
          .filter((tool) => listed.includes(tool.name))
          .map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.name, parameters: { type: "object" } },
          })),
      getUnavailableToolNames: () => new Set(unavailable),
      dispatch: async () => ({ content: "{}" }),
    } as unknown as ToolRegistry;
  }

  function contextWithRegistry(registry: ToolRegistry | undefined): ToolRuntimeAttemptContext {
    return {
      callId: "call-file-tools",
      toolName: "exec_command",
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      approvalResolved: false,
      invocation: {
        session: { services: registry === undefined ? {} : { registry } },
      },
    } as unknown as ToolRuntimeAttemptContext;
  }

  test("lists the file tools a refusal may name under the names the tools register", () => {
    expect(SHELL_FILE_WRITE_TOOL_NAMES).toEqual([
      FILE_EDIT_TOOL_NAME,
      FILE_WRITE_TOOL_NAME,
      FILE_MULTI_EDIT_TOOL_NAME,
      APPLY_PATCH_TOOL_NAME,
    ]);
  });

  test("reads the editing tools from the session's own registry", () => {
    const context = contextWithRegistry(
      registryOf(["exec_command", "FileRead", "Write", "Edit", "apply_patch"]),
    );
    expect(shellFileWriteTools(context)).toEqual({
      listed: ["Edit", "Write", "apply_patch"],
      unlisted: [],
    });
  });

  test("leaves out a tool the registry keeps only for telemetry", () => {
    const context = contextWithRegistry(
      registryOf(["exec_command", "Edit", "Write"], ["Write"]),
    );
    expect(shellFileWriteTools(context)).toEqual({ listed: ["Edit"], unlisted: [] });
  });

  test("splits the tools the model was given from those system.searchTools loads", () => {
    const context = contextWithRegistry(
      registryOf(
        ["system.searchTools", "exec_command", "Edit", "Write", "apply_patch"],
        [],
        ["system.searchTools", "exec_command", "apply_patch"],
      ),
    );
    expect(shellFileWriteTools(context)).toEqual({
      listed: ["apply_patch"],
      unlisted: ["Edit", "Write"],
      loadWith: "system.searchTools",
    });
  });

  test("an OpenAI Light registry lists apply_patch and keeps Edit and Write loadable", () => {
    // The production registry: Light sessions on the openai provider start
    // with apply_patch (light-profile.ts), the shape a benchmark run sees.
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      lightMode: true,
      requireAdmission: false,
      getSession: () => ({ services: { provider: { name: "openai" } } }) as never,
    });
    const tools = shellFileWriteTools(contextWithRegistry(registry));
    expect(tools?.listed).toEqual(["apply_patch"]);
    expect(tools?.unlisted).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(tools?.loadWith).toBe("system.searchTools");
  });

  test("is empty for a read-only role's registry", () => {
    // The registry a verification, Plan or scanner child gets: the parent's
    // tools with the role's denylist folded in, as run-agent builds it.
    const parent = registryOf([
      "exec_command",
      "write_stdin",
      "FileRead",
      "Grep",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "apply_patch",
    ]);
    const child = buildFilteredRegistry(parent, {
      childConversationId: "verify-child",
      disabledTools: mergeRoleDisallowlist(new Set<string>(), BUILTIN_READONLY_DISALLOWLIST),
    });
    expect(child.tools.map((tool) => tool.name)).toContain("exec_command");
    expect(shellFileWriteTools(contextWithRegistry(child))).toEqual({ listed: [], unlisted: [] });
  });

  test("is undefined without a session registry, so the refusal keeps its defaults", () => {
    expect(shellFileWriteTools(undefined)).toBeUndefined();
    expect(shellFileWriteTools(contextWithRegistry(undefined))).toBeUndefined();
  });

  test("reaches the shell tools through the permission they read from their args", () => {
    const args: Record<string, unknown> = { cmd: "echo hi > notes.txt" };
    attachToolRuntimeContext(args, contextWithRegistry(registryOf(["exec_command"])));
    expect(shellWorkspaceMutationPermission(args).fileWriteTools()).toEqual({
      listed: [],
      unlisted: [],
    });
    expect(shellWorkspaceMutationPermission({}).fileWriteTools()).toBeUndefined();
  });
});
