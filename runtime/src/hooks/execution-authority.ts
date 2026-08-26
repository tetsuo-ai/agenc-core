import { peekAmbientRuntimeSession } from "../session/current-session.js";
import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { isHookExecutionSuppressed } from "./runtime-policy.js";

export type HookEffect =
  | "internal"
  | "command"
  | "http"
  | "prompt"
  | "agent";

export type HookExecutionBlockReason =
  | "hard_suppressed"
  | "missing_session_authority"
  | "trust_lookup_failed"
  | "untrusted_workspace"
  | "untrusted_command_opt_in_only";

export type HookExecutionDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: HookExecutionBlockReason }>;

export type HookExecutionRuntimeAuthority = Pick<
  AgentRuntimeOptions,
  "simpleMode" | "allowUntrustedHooks"
>;

export interface HookExecutionAuthority {
  decision(effect: HookEffect): HookExecutionDecision;
}

export interface CreateHookExecutionAuthorityOptions {
  readonly runtimeOptions: HookExecutionRuntimeAuthority;
  readonly isWorkspaceTrusted: () => boolean;
}

const ALLOWED: HookExecutionDecision = Object.freeze({ allowed: true });

function blocked(reason: HookExecutionBlockReason): HookExecutionDecision {
  return Object.freeze({ allowed: false, reason });
}

/**
 * Bind every hook-effect decision to one immutable session capability and one
 * workspace-specific trust lookup.
 */
export function createHookExecutionAuthority(
  options: CreateHookExecutionAuthorityOptions,
): HookExecutionAuthority {
  const runtimeOptions = options.runtimeOptions;
  const allowUntrustedCommands = options.runtimeOptions.allowUntrustedHooks;
  const isWorkspaceTrusted = options.isWorkspaceTrusted;

  return Object.freeze({
    decision(effect: HookEffect): HookExecutionDecision {
      if (isHookExecutionSuppressed(runtimeOptions)) {
        return blocked("hard_suppressed");
      }
      if (effect === "internal") return ALLOWED;

      let trusted: boolean;
      try {
        trusted = isWorkspaceTrusted();
      } catch {
        return blocked("trust_lookup_failed");
      }
      if (trusted) return ALLOWED;
      if (effect === "command" && allowUntrustedCommands) return ALLOWED;
      return blocked(
        allowUntrustedCommands
          ? "untrusted_command_opt_in_only"
          : "untrusted_workspace",
      );
    },
  });
}

/**
 * Resolve the authority owned by the active session. External effects fail
 * closed when no unambiguous session is bound; internal callbacks remain
 * available unless immutable bare mode suppresses every hook extension point.
 */
export function resolveAmbientHookExecutionDecision(
  effect: HookEffect,
): HookExecutionDecision {
  const authority = peekAmbientRuntimeSession()?.services.hookExecutionAuthority;
  if (authority !== undefined) return authority.decision(effect);
  if (isHookExecutionSuppressed()) return blocked("hard_suppressed");
  return effect === "internal"
    ? ALLOWED
    : blocked("missing_session_authority");
}
