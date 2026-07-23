import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ID_ARG,
  SESSION_ID_SIG_ARG,
  signSessionId,
} from "../_deps/filesystem-args.js";
import type { Session } from "../../session/session.js";
import {
  currentAgentContext,
  isCurrentAgentContextError,
  strictArgs,
  type MultiAgentV2Options,
} from "./common.js";

const ROOT_SESSION_ID = "root-session";
const CHILD_SESSION_ID = "child-session";

function fixture() {
  const child = {
    agentId: CHILD_SESSION_ID,
    agentPath: "/root/child",
    nickname: "Child",
    role: { name: "worker" },
  };
  const getLive = vi.fn((id: string) =>
    id === CHILD_SESSION_ID ? child : undefined,
  );
  const session = {
    conversationId: ROOT_SESSION_ID,
  } as unknown as Session;
  const opts = {
    getSession: () => session,
    workspace: {},
    ensureAgentControl: () => ({
      control: { getLive },
      registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  return { child, getLive, opts, session };
}

function expectIdentityError(
  value: ReturnType<typeof currentAgentContext>,
  reason: string,
): void {
  expect(isCurrentAgentContextError(value)).toBe(true);
  if (!isCurrentAgentContextError(value)) return;
  expect(value.isError).toBe(true);
  expect(JSON.parse(value.content)).toEqual({
    error: "invalid-runtime-identity",
    reason,
  });
}

describe("MultiAgentV2 runtime identity", () => {
  it("uses root identity only when the internal identity pair is absent", () => {
    const { getLive, opts, session } = fixture();

    expect(currentAgentContext(session, {}, opts)).toEqual({
      threadId: ROOT_SESSION_ID,
      agentPath: "/root",
    });
    expect(getLive).not.toHaveBeenCalled();
  });

  it("accepts a valid signed root identity", () => {
    const { getLive, opts, session } = fixture();

    expect(
      currentAgentContext(
        session,
        {
          [SESSION_ID_ARG]: ROOT_SESSION_ID,
          [SESSION_ID_SIG_ARG]: signSessionId(ROOT_SESSION_ID),
        },
        opts,
      ),
    ).toEqual({
      threadId: ROOT_SESSION_ID,
      agentPath: "/root",
    });
    expect(getLive).not.toHaveBeenCalled();
  });

  it("accepts a valid signed live child identity", () => {
    const { opts, session } = fixture();

    expect(
      currentAgentContext(
        session,
        {
          [SESSION_ID_ARG]: CHILD_SESSION_ID,
          [SESSION_ID_SIG_ARG]: signSessionId(CHILD_SESSION_ID),
        },
        opts,
      ),
    ).toEqual({
      threadId: CHILD_SESSION_ID,
      agentPath: "/root/child",
      agentNickname: "Child",
      agentRole: "worker",
    });
  });

  it.each([
    {
      name: "missing signature",
      args: { [SESSION_ID_ARG]: CHILD_SESSION_ID },
      reason: "identity_pair_incomplete",
    },
    {
      name: "missing id",
      args: { [SESSION_ID_SIG_ARG]: signSessionId(CHILD_SESSION_ID) },
      reason: "identity_pair_incomplete",
    },
    {
      name: "forged signature",
      args: {
        [SESSION_ID_ARG]: CHILD_SESSION_ID,
        [SESSION_ID_SIG_ARG]: "00".repeat(32),
      },
      reason: "identity_signature_invalid",
    },
    {
      name: "signature for a different id",
      args: {
        [SESSION_ID_ARG]: CHILD_SESSION_ID,
        [SESSION_ID_SIG_ARG]: signSessionId("different-session"),
      },
      reason: "identity_signature_invalid",
    },
  ])("rejects $name without falling back to root", ({ args, reason }) => {
    const { opts, session } = fixture();

    expectIdentityError(currentAgentContext(session, args, opts), reason);
  });

  it("rejects a correctly signed identity that is not a live agent", () => {
    const { opts, session } = fixture();
    const unknownId = "unknown-child";

    expectIdentityError(
      currentAgentContext(
        session,
        {
          [SESSION_ID_ARG]: unknownId,
          [SESSION_ID_SIG_ARG]: signSessionId(unknownId),
        },
        opts,
      ),
      "identity_not_live",
    );
  });

  it("permits the signed identity pair as internal strict arguments", () => {
    const roundTrippedArgs = JSON.parse(
      JSON.stringify({
        target: "child",
        [SESSION_ID_ARG]: CHILD_SESSION_ID,
        [SESSION_ID_SIG_ARG]: signSessionId(CHILD_SESSION_ID),
      }),
    ) as Record<string, unknown>;

    expect(
      strictArgs(roundTrippedArgs, {
        allowed: new Set(["target"]),
        required: ["target"],
      }),
    ).toBeNull();
  });
});
