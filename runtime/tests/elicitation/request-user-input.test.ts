import { describe, expect, it, vi } from "vitest";

import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
} from "../permissions/types.js";
import type {
  ManagedFeatures,
  SessionConfiguration,
} from "../session/turn-context.js";
import {
  createRequestUserInputTool,
  normalizeRequestUserInputArgs,
  requestUserInputAvailableModes,
  requestUserInputToolDescription,
  type RequestUserInputToolSession,
} from "./request-user-input.js";
import type { RequestUserInputResponse } from "./types.js";

function features(defaultMode = false): ManagedFeatures {
  return {
    enabled: (key) =>
      key === "default_mode_request_user_input" && defaultMode,
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function registry(mode: PermissionMode): PermissionModeRegistry {
  return new PermissionModeRegistry({
    ...createEmptyToolPermissionContext(),
    mode,
  });
}

function sessionConfiguration(
  sessionSource: SessionConfiguration["sessionSource"] = "cli_main",
): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource,
  };
}

function makeSession(
  opts: {
    readonly mode?: PermissionMode;
    readonly defaultMode?: boolean;
    readonly source?: SessionConfiguration["sessionSource"];
    readonly response?: RequestUserInputResponse | null;
  } = {},
): RequestUserInputToolSession & {
  readonly requestUserInput: ReturnType<typeof vi.fn>;
} {
  return {
    features: features(opts.defaultMode),
    permissionModeRegistry: registry(opts.mode ?? "plan"),
    sessionConfiguration: sessionConfiguration(opts.source),
    requestUserInput: vi.fn().mockResolvedValue(
      opts.response ?? {
        answers: { choice: { answers: ["Yes"] } },
      },
    ),
  };
}

const VALID_ARGS = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Proceed?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Yes (Recommended)", description: "Continue now." },
        { label: "No", description: "Stop now." },
      ],
    },
  ],
};

describe("request_user_input", () => {
  it("normalizes choice questions by adding Other", () => {
    const normalized = normalizeRequestUserInputArgs(VALID_ARGS);
    expect(normalized.questions[0]).toMatchObject({
      id: "choice",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Yes (Recommended)", description: "Continue now." },
        { label: "No", description: "Stop now." },
      ],
    });
  });

  it("normalizes fill-text questions without options", () => {
    expect(
      normalizeRequestUserInputArgs({
        questions: [{ id: "x", header: "X", question: "Describe the issue" }],
      }).questions[0],
    ).toMatchObject({
      id: "x",
      isOther: true,
      isSecret: false,
    });
    expect(
      normalizeRequestUserInputArgs({
        questions: [
          { id: "x", header: "X", question: "Describe the issue", options: [] },
        ],
      }).questions[0],
    ).toMatchObject({
      id: "x",
      options: [],
    });
  });

  it("does not let the generic model-facing tool forge clientAction", () => {
    expect(() =>
      normalizeRequestUserInputArgs({
        ...VALID_ARGS,
        clientAction: {
          type: "ledger_solana_transfer_v1",
          to: "11111111111111111111111111111111",
          lamports: "1",
        },
      }),
    ).toThrow("request_user_input cannot set clientAction");
  });

  it("enforces question and option cardinality", () => {
    expect(() => normalizeRequestUserInputArgs({ questions: [] })).toThrow(
      "request_user_input requires 1-3 questions",
    );
    expect(() =>
      normalizeRequestUserInputArgs({
        questions: [
          VALID_ARGS.questions[0],
          VALID_ARGS.questions[0],
          VALID_ARGS.questions[0],
          VALID_ARGS.questions[0],
        ],
      }),
    ).toThrow("request_user_input requires 1-3 questions");
    expect(() =>
      normalizeRequestUserInputArgs({
        questions: [
          {
            ...VALID_ARGS.questions[0],
            options: [{ label: "Only", description: "Single option." }],
          },
        ],
      }),
    ).toThrow("request_user_input requires either fill-text questions or 2-3 options");
    expect(() =>
      normalizeRequestUserInputArgs({
        questions: [
          {
            ...VALID_ARGS.questions[0],
            options: [
              { label: "A", description: "A." },
              { label: "B", description: "B." },
              { label: "C", description: "C." },
              { label: "D", description: "D." },
            ],
          },
        ],
      }),
    ).toThrow("request_user_input requires either fill-text questions or 2-3 options");
  });

  it("rejects secret questions because the TUI has no redaction path", () => {
    expect(() =>
      normalizeRequestUserInputArgs({
        questions: [
          {
            ...VALID_ARGS.questions[0],
            isSecret: true,
          },
        ],
      }),
    ).toThrow("request_user_input does not support secret questions");
    expect(() =>
      normalizeRequestUserInputArgs({
        questions: [
          {
            ...VALID_ARGS.questions[0],
            isSecret: "true",
          },
        ],
      }),
    ).toThrow("request_user_input requires question.isSecret to be a boolean");
  });

  it("describes Plan mode by default and Default or Plan with feature enabled", () => {
    expect(requestUserInputAvailableModes(features())).toEqual(["plan"]);
    expect(
      requestUserInputToolDescription(
        requestUserInputAvailableModes(features()),
      ),
    ).toContain("Plan mode");
    expect(requestUserInputAvailableModes(features(true))).toEqual([
      "default",
      "plan",
    ]);
    expect(
      requestUserInputToolDescription(
        requestUserInputAvailableModes(features(true)),
      ),
    ).toContain("Default or Plan mode");
  });

  it("marks request_user_input as interactive and replay-unsafe", () => {
    const session = makeSession();
    const tool = createRequestUserInputTool({ getSession: () => session });

    expect(tool.metadata?.mutating).toBe(true);
    expect(tool.recoveryCategory).toBe("interactive");
    expect(tool.requiresUserInteraction?.()).toBe(true);
    expect(tool.supportsParallelToolCalls).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(tool.interruptBehavior?.()).toBe("cancel");
  });

  it("waits for a root plan-mode session response", async () => {
    const session = makeSession();
    const tool = createRequestUserInputTool({ getSession: () => session });
    const result = await tool.execute({ ...VALID_ARGS, __callId: "call-1" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      answers: { choice: { answers: ["Yes"] } },
    });
    expect(session.requestUserInput).toHaveBeenCalledWith(
      "call-1",
      {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Proceed?",
            isOther: true,
            isSecret: false,
            options: [
              {
                label: "Yes (Recommended)",
                description: "Continue now.",
              },
              {
                label: "No",
                description: "Stop now.",
              },
            ],
          },
        ],
      },
      undefined,
    );
  });

  it("rejects unavailable modes and subagent sessions", async () => {
    const defaultModeSession = makeSession({ mode: "default" });
    const unavailable = await createRequestUserInputTool({
      getSession: () => defaultModeSession,
    }).execute(VALID_ARGS);
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content).toContain(
      "request_user_input is unavailable in Default mode",
    );

    const subagentSession = makeSession({ source: "cli_subagent" });
    const subagent = await createRequestUserInputTool({
      getSession: () => subagentSession,
    }).execute(VALID_ARGS);
    expect(subagent.isError).toBe(true);
    expect(subagent.content).toContain(
      "request_user_input can only be used by the root thread",
    );
  });
});
