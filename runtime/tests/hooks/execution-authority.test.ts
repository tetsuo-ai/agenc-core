import { describe, expect, test } from "vitest";

import {
  createHookExecutionAuthority,
  resolveAmbientHookExecutionDecision,
  type HookEffect,
} from "../../src/hooks/execution-authority.js";
import { runWithCurrentRuntimeSession } from "../../src/session/current-session.js";

const EXTERNAL_EFFECTS: readonly HookEffect[] = [
  "command",
  "http",
  "prompt",
  "agent",
];

function authority(options: {
  readonly trusted: boolean;
  readonly allowUntrustedCommands?: boolean;
  readonly simpleMode?: boolean;
}) {
  return createHookExecutionAuthority({
    runtimeOptions: {
      simpleMode: options.simpleMode ?? false,
      allowUntrustedHooks: options.allowUntrustedCommands ?? false,
    },
    isWorkspaceTrusted: () => options.trusted,
  });
}

describe("hook execution authority", () => {
  test("allows every effect in a trusted workspace", () => {
    const trusted = authority({ trusted: true });
    for (const effect of ["internal", ...EXTERNAL_EFFECTS] as const) {
      expect(trusted.decision(effect)).toEqual({ allowed: true });
    }
  });

  test("allows only internal effects in an untrusted workspace by default", () => {
    const untrusted = authority({ trusted: false });
    expect(untrusted.decision("internal")).toEqual({ allowed: true });
    for (const effect of EXTERNAL_EFFECTS) {
      expect(untrusted.decision(effect)).toEqual({
        allowed: false,
        reason: "untrusted_workspace",
      });
    }
  });

  test("limits the automation opt-in to command effects", () => {
    const automation = authority({
      trusted: false,
      allowUntrustedCommands: true,
    });
    expect(automation.decision("internal")).toEqual({ allowed: true });
    expect(automation.decision("command")).toEqual({ allowed: true });
    for (const effect of ["http", "prompt", "agent"] as const) {
      expect(automation.decision(effect)).toEqual({
        allowed: false,
        reason: "untrusted_command_opt_in_only",
      });
    }
  });

  test("fails external effects closed when project trust cannot be read", () => {
    const unavailable = createHookExecutionAuthority({
      runtimeOptions: { simpleMode: false, allowUntrustedHooks: true },
      isWorkspaceTrusted: () => {
        throw new Error("trust ledger unavailable");
      },
    });

    expect(unavailable.decision("internal")).toEqual({ allowed: true });
    for (const effect of EXTERNAL_EFFECTS) {
      expect(unavailable.decision(effect)).toEqual({
        allowed: false,
        reason: "trust_lookup_failed",
      });
    }
  });

  test("fails external effects closed when a session has no authority", async () => {
    const missingAuthoritySession = { services: {} } as never;
    const [internal, command] = await runWithCurrentRuntimeSession(
      missingAuthoritySession,
      async () => [
        resolveAmbientHookExecutionDecision("internal"),
        resolveAmbientHookExecutionDecision("command"),
      ],
    );

    expect(internal).toEqual({ allowed: true });
    expect(command).toEqual({
      allowed: false,
      reason: "missing_session_authority",
    });
  });

  test("bare mode denies every hook effect", () => {
    const bare = authority({
      trusted: true,
      allowUntrustedCommands: true,
      simpleMode: true,
    });
    for (const effect of ["internal", ...EXTERNAL_EFFECTS] as const) {
      expect(bare.decision(effect)).toEqual({
        allowed: false,
        reason: "hard_suppressed",
      });
    }
  });

  test("keeps opposite daemon-session capabilities isolated", async () => {
    const allowedSession = {
      services: {
        hookExecutionAuthority: authority({
          trusted: false,
          allowUntrustedCommands: true,
        }),
      },
    } as never;
    const deniedSession = {
      services: {
        hookExecutionAuthority: authority({ trusted: false }),
      },
    } as never;

    const [allowed, denied] = await Promise.all([
      runWithCurrentRuntimeSession(allowedSession, async () => {
        await Promise.resolve();
        return resolveAmbientHookExecutionDecision("command");
      }),
      runWithCurrentRuntimeSession(deniedSession, async () => {
        await Promise.resolve();
        return resolveAmbientHookExecutionDecision("command");
      }),
    ]);

    expect(allowed).toEqual({ allowed: true });
    expect(denied).toEqual({
      allowed: false,
      reason: "untrusted_workspace",
    });
  });
});
