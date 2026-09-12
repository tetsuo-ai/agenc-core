import { afterEach, describe, expect, test, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  shellAdditionalWriteRoots,
  shellBypassesApprovalsAndSandbox,
  shellDeletionProtectedRoots,
} from "src/tools/system/shell-mutation-permission.js";
import type { ToolRuntimeAttemptContext } from "src/tools/runtimes/context.js";

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
