import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { NetworkApprovalService } from "../../permissions/network-approval.js";
import { Policy } from "../execpolicy/policy.js";
import type { Tool } from "../../tools/types.js";
import {
  availableDecisionKinds,
  defaultAvailableApprovalDecisions,
  effectiveApprovalId,
  effectiveAvailableApprovalDecisions,
  reviewDecisionAllowsEscalation,
} from "./approvals.js";
import {
  managedNetworkApprovalContext,
  networkApprovalSandboxGate,
  requestManagedNetworkApprovalForSandbox,
} from "./network-approval.js";
import {
  prefixRuleAllowedForCommand,
  renderOnRequestEscalationGuidance,
  shouldRetryWithEscalationAfterFailure,
} from "./on-request.js";
import {
  allowedAdditionalPermissionNames,
  preferAdditionalPermissions,
} from "./on-request-rule-request-permission.js";
import {
  approvalSandboxPermissions,
  managedNetworkForSandboxPermissions,
  sandboxPermissionsFromArgs,
  sandboxOverrideForFirstAttempt,
  selectFirstAttemptSandbox,
  toolWantsNoSandboxApproval,
} from "./sandboxing.js";
import {
  REJECT_RULES_APPROVAL_REASON,
  commandsForInterceptedExecPolicy,
  determineInterceptedExecAction,
  evaluateInterceptedExecPolicy,
  execvePromptRejectedByPolicy,
  joinProgramAndArgv,
} from "./unix-escalation.js";

const execFileAsync = promisify(execFile);

const tool: Tool = {
  name: "shell",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};

describe("sandbox escalation policy", () => {
  test("require_escalated selects a sandbox bypass for the subprocess attempt", async () => {
    const override = sandboxOverrideForFirstAttempt("require_escalated", {
      kind: "skip",
      bypassSandbox: false,
    });
    const selected = selectFirstAttemptSandbox("workspace_write", override);
    expect(selected).toBe("danger_full_access");

    const child = await execFileAsync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.AGENC_TEST_SANDBOX ?? '')"],
      {
        env: { ...process.env, AGENC_TEST_SANDBOX: selected },
        encoding: "utf8",
      },
    );
    expect(child.stdout).toBe("danger_full_access");
  });

  test("additional permissions are stripped after preapproval and retain managed network", () => {
    const request = {
      kind: "with_additional_permissions" as const,
      additionalPermissions: {
        network: { enabled: true },
        file_system: { read: ["/tmp/input"], write: ["/tmp/output"] },
      },
    };
    expect(approvalSandboxPermissions(request, true)).toEqual({
      kind: "default",
    });
    expect(managedNetworkForSandboxPermissions("managed", request)).toBe(
      "managed",
    );
    expect(managedNetworkForSandboxPermissions("managed", "require_escalated"))
      .toBeNull();
  });

  test("policy table controls sandbox-denial approval prompts", () => {
    expect(toolWantsNoSandboxApproval(tool, "on_failure")).toBe(true);
    expect(toolWantsNoSandboxApproval(tool, "untrusted")).toBe(true);
    expect(toolWantsNoSandboxApproval(tool, "on_request")).toBe(false);
    expect(
      toolWantsNoSandboxApproval(tool, "granular", {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      }),
    ).toBe(true);
  });
});

describe("approval event decisions", () => {
  test("approval id falls back to call id", () => {
    expect(
      effectiveApprovalId({ callId: "call-1", command: ["npm", "test"] }),
    ).toBe("call-1");
    expect(
      effectiveApprovalId({
        callId: "call-1",
        approvalId: "approval-1",
        command: ["npm", "test"],
      }),
    ).toBe("approval-1");
  });

  test("default decisions require explicit proposed network amendments", () => {
    expect(
      availableDecisionKinds(
        defaultAvailableApprovalDecisions({
          networkApprovalContext: {
            host: "registry.npmjs.org",
            protocol: "https",
          },
        }),
      ),
    ).toEqual(["approved", "approved_for_session", "abort"]);
    expect(
      availableDecisionKinds(
        defaultAvailableApprovalDecisions({
          networkApprovalContext: {
            host: "registry.npmjs.org",
            protocol: "https",
          },
          proposedNetworkPolicyAmendments: [
            {
              action: "allow",
              host: "registry.npmjs.org",
              protocol: "https",
              port: 443,
            },
          ],
        }),
      ),
    ).toEqual([
      "approved",
      "approved_for_session",
      "network_policy_amendment",
      "abort",
    ]);
    expect(
      availableDecisionKinds(
        defaultAvailableApprovalDecisions({
          networkApprovalContext: {
            host: "registry.npmjs.org",
            protocol: "https",
          },
          proposedNetworkPolicyAmendments: [
            {
              action: "deny",
              host: "registry.npmjs.org",
              protocol: "https",
              port: 443,
            },
          ],
        }),
      ),
    ).toEqual(["approved", "approved_for_session", "abort"]);
    expect(
      availableDecisionKinds(
        defaultAvailableApprovalDecisions({
          additionalPermissions: { network: { enabled: true } },
        }),
      ),
    ).toEqual(["approved", "abort"]);
    expect(
      availableDecisionKinds(
        defaultAvailableApprovalDecisions({
          proposedExecPolicyAmendment: { prefix: ["npm", "test"] },
        }),
      ),
    ).toEqual(["approved", "approved_execpolicy_amendment", "abort"]);
    expect(
      effectiveAvailableApprovalDecisions({
        callId: "call-explicit",
        command: ["npm", "test"],
        availableDecisions: [{ kind: "abort" }],
      }),
    ).toEqual([{ kind: "abort" }]);
    expect(
      reviewDecisionAllowsEscalation({
        kind: "network_policy_amendment",
        amendment: {
          action: "deny",
          host: "registry.npmjs.org",
          protocol: "https",
          port: 443,
        },
      }),
    ).toBe(false);
  });
});

describe("intercepted exec escalation", () => {
  test("prefix allow rules drive unsandboxed execution", () => {
    const policy = Policy.empty();
    policy.addPrefixRule(["/usr/bin/git", "status"], "allow");
    const evaluated = evaluateInterceptedExecPolicy({
      policy,
      program: "/usr/bin/git",
      argv: ["git", "status"],
      unmatchedCommandContext: {
        approvalPolicy: "on_request",
        fileSystemSandboxKind: "restricted",
        sandboxPermissions: "default",
      },
    });
    expect(evaluated.commands).toEqual([["/usr/bin/git", "status"]]);
    expect(evaluated.evaluation.decision).toBe("allow");

    const action = determineInterceptedExecAction({
      evaluation: evaluated.evaluation,
      approvalPolicy: "on_request",
    });
    expect(action).toMatchObject({
      kind: "run",
      execution: { kind: "unsandboxed" },
      source: "prefix_rule",
      needsEscalation: true,
    });
  });

  test("unmatched prompt decisions require approval before execution", () => {
    const evaluated = evaluateInterceptedExecPolicy({
      policy: Policy.empty(),
      program: "/usr/bin/madeup-cmd",
      argv: ["madeup-cmd"],
      unmatchedCommandContext: {
        approvalPolicy: "on_request",
        fileSystemSandboxKind: "restricted",
        sandboxPermissions: "require_escalated",
      },
    });
    expect(evaluated.evaluation.decision).toBe("prompt");
    expect(
      determineInterceptedExecAction({
        evaluation: evaluated.evaluation,
        approvalPolicy: "on_request",
        sandboxPermissions: "require_escalated",
      }),
    ).toMatchObject({
      kind: "prompt",
      execution: { kind: "unsandboxed" },
      needsEscalation: true,
    });
  });

  test("forbidden intercepted exec denies directly", () => {
    const policy = Policy.empty();
    policy.addPrefixRule(["/bin/rm"], "forbidden");
    const evaluated = evaluateInterceptedExecPolicy({
      policy,
      program: "/bin/rm",
      argv: ["rm", "-rf", "/tmp/output"],
      unmatchedCommandContext: {
        approvalPolicy: "on_request",
        fileSystemSandboxKind: "restricted",
        sandboxPermissions: "default",
      },
    });
    expect(evaluated.evaluation.decision).toBe("forbidden");
    expect(
      determineInterceptedExecAction({
        evaluation: evaluated.evaluation,
        approvalPolicy: "on_request",
      }),
    ).toMatchObject({
      kind: "deny",
      reason: "Execution forbidden by policy",
    });
  });

  test("granular policy rejects rule prompts when rule approval is disabled", () => {
    expect(
      execvePromptRejectedByPolicy(
        "granular",
        "prefix_rule",
        {
          sandbox_approval: true,
          rules: false,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
      ),
    ).toBe(REJECT_RULES_APPROVAL_REASON);
  });

  test("shell wrapper parsing splits word-only command segments", () => {
    expect(
      commandsForInterceptedExecPolicy({
        program: "/bin/zsh",
        argv: ["zsh", "-lc", "git status && npm test"],
        parseShellWrapper: true,
      }),
    ).toEqual([
      ["git", "status"],
      ["npm", "test"],
    ]);
    expect(joinProgramAndArgv("/usr/bin/node", ["node", "-v"])).toEqual([
      "/usr/bin/node",
      "-v",
    ]);
  });
});

describe("network approval escalation", () => {
  test("sandbox gate denies unmanaged modes before invoking resolver", async () => {
    const gate = networkApprovalSandboxGate(
      { kind: "danger_full_access" },
      "on_request",
    );
    expect(gate).toEqual({
      kind: "denied",
      reason: "not_allowed_in_sandbox_mode",
    });

    const service = new NetworkApprovalService();
    const blockedResolver = vi.fn(async () => ({ kind: "approved" as const }));
    const blockedDecision = await requestManagedNetworkApprovalForSandbox({
      service,
      key: { host: "registry.npmjs.org", protocol: "https", port: 443 },
      sandboxPolicy: { kind: "danger_full_access" },
      approvalPolicy: "on_request",
      resolver: { requestNetworkApproval: blockedResolver },
    });
    expect(blockedDecision).toEqual({
      kind: "deny",
      reason: "not_allowed_in_sandbox_mode",
    });
    expect(blockedResolver).not.toHaveBeenCalled();

    const decision = await requestManagedNetworkApprovalForSandbox({
      service,
      key: { host: "Registry.NPMJS.org.", protocol: "https", port: 443 },
      sandboxPolicy: { kind: "workspace_write" },
      approvalPolicy: "on_request",
      resolver: {
        requestNetworkApproval: async (ctx) => {
          expect(ctx.host).toBe("registry.npmjs.org");
          return { kind: "approved_for_session" };
        },
      },
    });
    expect(decision).toEqual({ kind: "allow" });
    expect(
      managedNetworkApprovalContext({
        host: "Registry.NPMJS.org.",
        protocol: "https",
        port: 443,
      }),
    ).toMatchObject({
      host: "registry.npmjs.org",
      target: "https://registry.npmjs.org:443",
      cacheKey: "https://registry.npmjs.org:443",
    });
  });
});

describe("prompt guidance helpers", () => {
  test("guidance prefers scoped permissions and conservative reusable rules", () => {
    expect(renderOnRequestEscalationGuidance()).toContain(
      'sandbox_permissions="require_escalated"',
    );
    expect(shouldRetryWithEscalationAfterFailure("EACCES: permission denied"))
      .toBe(true);
    expect(prefixRuleAllowedForCommand(["rm", "-rf", "dist"])).toBe(false);
    expect(prefixRuleAllowedForCommand(["grep", "rm", "file.txt"])).toBe(true);
    expect(prefixRuleAllowedForCommand(["git", "-C", "repo", "reset", "--hard"]))
      .toBe(false);
    expect(prefixRuleAllowedForCommand(["bash", "-lc", "git reset --hard"]))
      .toBe(false);
    const permissions = {
      network: { enabled: true },
      file_system: { read: ["/tmp/a"] },
    };
    expect(preferAdditionalPermissions(permissions)).toBe(true);
    expect(allowedAdditionalPermissionNames(permissions)).toEqual([
      "network.enabled",
      "file_system.read",
    ]);
    expect(
      sandboxPermissionsFromArgs({
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: { file_system: { read: "/tmp/not-array" } },
      }),
    ).toEqual({
      kind: "with_additional_permissions",
      additionalPermissions: {},
    });
  });
});
