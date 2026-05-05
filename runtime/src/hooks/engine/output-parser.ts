/**
 * Command-hook output parser.
 *
 * Ports the Rust hook output parser listed in `PARITY.md` onto the JSON
 * forms emitted by AgenC command hooks.
 */

export type HookPermissionBehavior = "allow" | "deny" | "ask";

export type HookSpecificOutput = {
  readonly hookEventName?: string;
  readonly permissionDecision?: HookPermissionBehavior;
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly additionalContext?: string;
  readonly decision?: {
    readonly behavior?: string;
    readonly updatedInput?: Record<string, unknown>;
    readonly message?: string;
  };
};

export interface ParsedHookSpecificOutput {
  readonly explicit: boolean;
  readonly output?: HookSpecificOutput;
  readonly invalid?: string;
}

export function parseHookSpecificOutput(
  stdout: string,
): HookSpecificOutput | undefined {
  return readHookSpecificOutput(stdout).output;
}

export function readHookSpecificOutput(stdout: string): ParsedHookSpecificOutput {
  const raw = stdout.trim();
  if (!raw.startsWith("{")) return { explicit: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        explicit: true,
        invalid: "hook output JSON must be an object",
      };
    }
    const rawSpecific =
      parsed.hookSpecificOutput === undefined
        ? parsed
        : isRecord(parsed.hookSpecificOutput)
          ? parsed.hookSpecificOutput
          : undefined;
    if (!rawSpecific) {
      return {
        explicit: true,
        invalid: "hookSpecificOutput must be an object",
      };
    }
    const { output, invalid } = normalizeHookSpecificOutput(rawSpecific);
    return {
      explicit: true,
      output,
      ...(invalid.length > 0 ? { invalid: invalid.join("; ") } : {}),
    };
  } catch {
    return {
      explicit: true,
      invalid: "hook output JSON could not be parsed",
    };
  }
}

function normalizeHookSpecificOutput(
  raw: Record<string, unknown>,
): { output: HookSpecificOutput; invalid: string[] } {
  const invalid: string[] = [];
  const output: {
    hookEventName?: string;
    permissionDecision?: HookPermissionBehavior;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: {
      behavior?: string;
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
  } = {};

  if (typeof raw.hookEventName === "string") {
    output.hookEventName = raw.hookEventName;
  }
  if (raw.permissionDecision !== undefined) {
    if (isHookPermissionBehavior(raw.permissionDecision)) {
      output.permissionDecision = raw.permissionDecision;
    } else {
      invalid.push("permissionDecision must be allow, deny, or ask");
    }
  }
  if (raw.permissionDecisionReason !== undefined) {
    if (typeof raw.permissionDecisionReason === "string") {
      output.permissionDecisionReason = raw.permissionDecisionReason;
    } else {
      invalid.push("permissionDecisionReason must be a string");
    }
  }
  if (raw.updatedInput !== undefined) {
    if (isRecord(raw.updatedInput)) {
      output.updatedInput = raw.updatedInput;
    } else {
      invalid.push("updatedInput must be an object");
    }
  }
  if (raw.additionalContext !== undefined) {
    if (typeof raw.additionalContext === "string") {
      output.additionalContext = raw.additionalContext;
    } else {
      invalid.push("additionalContext must be a string");
    }
  }
  if (raw.decision !== undefined) {
    if (isRecord(raw.decision)) {
      const decision: {
        behavior?: string;
        updatedInput?: Record<string, unknown>;
        message?: string;
      } = {};
      if (typeof raw.decision.behavior === "string") {
        decision.behavior = raw.decision.behavior;
      }
      if (raw.decision.updatedInput !== undefined) {
        if (isRecord(raw.decision.updatedInput)) {
          decision.updatedInput = raw.decision.updatedInput;
        } else {
          invalid.push("decision.updatedInput must be an object");
        }
      }
      if (raw.decision.message !== undefined) {
        if (typeof raw.decision.message === "string") {
          decision.message = raw.decision.message;
        } else {
          invalid.push("decision.message must be a string");
        }
      }
      output.decision = decision;
    } else {
      invalid.push("decision must be an object");
    }
  }

  return { output, invalid };
}

function isHookPermissionBehavior(
  value: unknown,
): value is HookPermissionBehavior {
  return value === "allow" || value === "deny" || value === "ask";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
