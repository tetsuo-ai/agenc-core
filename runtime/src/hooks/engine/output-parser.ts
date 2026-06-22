/**
 * Command-hook output parser.
 *
 * Parses the JSON forms emitted by AgenC command hooks.
 */

import { isRecord } from "../../utils/record.js";

export type HookPermissionBehavior = "allow" | "deny" | "ask";

export type HookSpecificOutput = {
  readonly hookEventName?: string;
  readonly continueProcessing?: boolean;
  readonly stopReason?: string;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  readonly permissionDecision?: HookPermissionBehavior;
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly additionalContext?: string;
  readonly legacyDecision?: string;
  readonly reason?: string;
  readonly decision?: {
    readonly behavior?: string;
    readonly updatedInput?: Record<string, unknown>;
    readonly updatedPermissions?: Record<string, unknown>;
    readonly interrupt?: boolean;
    readonly message?: string;
  };
};

export interface ParsedHookSpecificOutput {
  readonly explicit: boolean;
  readonly output?: HookSpecificOutput;
  readonly invalid?: string;
}

export function readHookSpecificOutput(
  stdout: string,
  expectedEvent?: string,
): ParsedHookSpecificOutput {
  const raw = stdout.trim();
  if (raw.startsWith("[")) {
    return {
      explicit: true,
      invalid: "hook output JSON must be an object",
    };
  }
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
    validateKnownOutputFields({
      root: parsed,
      specific: rawSpecific,
      nested: rawSpecific !== parsed,
      expectedEvent,
      invalid,
    });
    if (rawSpecific !== parsed) {
      mergeCommonOutputFields(parsed, output, invalid);
      mergeRootEventOutputFields(parsed, output, invalid, expectedEvent);
    }
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

function mergeRootEventOutputFields(
  raw: Record<string, unknown>,
  output: {
    legacyDecision?: string;
    reason?: string;
    decision?: {
      behavior?: string;
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>;
      interrupt?: boolean;
      message?: string;
    };
  },
  invalid: string[],
  expectedEvent?: string,
): void {
  if (expectedEvent === "PermissionRequest") return;
  if (raw.reason !== undefined && output.reason === undefined) {
    if (typeof raw.reason === "string") {
      output.reason = raw.reason;
    } else {
      invalid.push("reason must be a string");
    }
  }
  if (
    raw.decision !== undefined &&
    output.legacyDecision === undefined &&
    output.decision === undefined
  ) {
    if (typeof raw.decision === "string") {
      output.legacyDecision = raw.decision;
    } else if (isRecord(raw.decision)) {
      output.decision = normalizeDecisionObject(raw.decision, invalid);
    } else {
      invalid.push("decision must be an object");
    }
  }
}

interface OutputFieldValidationInput {
  readonly root: Record<string, unknown>;
  readonly specific: Record<string, unknown>;
  readonly nested: boolean;
  readonly expectedEvent?: string;
  readonly invalid: string[];
}

function validateKnownOutputFields(input: OutputFieldValidationInput): void {
  const rootAllowed = new Set([
    "continue",
    "stopReason",
    "suppressOutput",
    "systemMessage",
    "hookSpecificOutput",
    "decision",
    "reason",
    ...(input.nested ? [] : specificKeysForEvent(input.expectedEvent)),
  ]);
  validateAllowedKeys(input.root, rootAllowed, input.invalid, "hook output");

  const specificAllowed = new Set([
    "hookEventName",
    "continue",
    "stopReason",
    "suppressOutput",
    "systemMessage",
    ...specificKeysForEvent(input.expectedEvent),
  ]);
  validateAllowedKeys(
    input.specific,
    specificAllowed,
    input.invalid,
    input.nested ? "hookSpecificOutput" : "hook output",
  );

  if (input.expectedEvent === "PermissionRequest") {
    if (input.root.decision !== undefined) {
      input.invalid.push(
        "PermissionRequest hook returned unsupported root decision",
      );
    }
    if (input.root.reason !== undefined) {
      input.invalid.push(
        "PermissionRequest hook returned unsupported root reason",
      );
    }
  }

  if (input.nested && input.expectedEvent !== undefined) {
    if (input.specific.hookEventName === undefined) {
      input.invalid.push(
        `hookSpecificOutput.hookEventName must be ${input.expectedEvent}`,
      );
    } else if (input.specific.hookEventName !== input.expectedEvent) {
      input.invalid.push(
        `hookSpecificOutput.hookEventName must be ${input.expectedEvent}`,
      );
    }
  }
}

function specificKeysForEvent(event: string | undefined): readonly string[] {
  switch (event) {
    case "PreToolUse":
      return [
        "permissionDecision",
        "permissionDecisionReason",
        "updatedInput",
        "additionalContext",
        "decision",
        "reason",
      ];
    case "PermissionRequest":
      return ["decision"];
    case "PostToolUse":
    case "UserPromptSubmit":
    case "SessionStart":
    case "PreCompact":
    case "PostCompact":
      return ["additionalContext", "decision", "reason"];
    case "Stop":
    case "StopFailure":
      return ["decision", "reason"];
    default:
      return [
        "permissionDecision",
        "permissionDecisionReason",
        "updatedInput",
        "additionalContext",
        "decision",
        "reason",
      ];
  }
}

function validateAllowedKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  invalid: string[],
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      invalid.push(`${label} returned unsupported field ${key}`);
    }
  }
}

function normalizeHookSpecificOutput(
  raw: Record<string, unknown>,
): { output: HookSpecificOutput; invalid: string[] } {
  const invalid: string[] = [];
  const output: {
    hookEventName?: string;
    continueProcessing?: boolean;
    stopReason?: string;
    suppressOutput?: boolean;
    systemMessage?: string;
    permissionDecision?: HookPermissionBehavior;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    legacyDecision?: string;
    reason?: string;
    decision?: {
      behavior?: string;
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>;
      interrupt?: boolean;
      message?: string;
    };
  } = {};

  if (typeof raw.hookEventName === "string") {
    output.hookEventName = raw.hookEventName;
  }
  mergeCommonOutputFields(raw, output, invalid);
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
  if (raw.reason !== undefined) {
    if (typeof raw.reason === "string") {
      output.reason = raw.reason;
    } else {
      invalid.push("reason must be a string");
    }
  }
  if (raw.decision !== undefined) {
    if (typeof raw.decision === "string") {
      output.legacyDecision = raw.decision;
      return { output, invalid };
    }
    if (isRecord(raw.decision)) {
      output.decision = normalizeDecisionObject(raw.decision, invalid);
    } else {
      invalid.push("decision must be an object");
    }
  }

  return { output, invalid };
}

function normalizeDecisionObject(
  raw: Record<string, unknown>,
  invalid: string[],
): {
  behavior?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Record<string, unknown>;
  interrupt?: boolean;
  message?: string;
} {
  const decision: {
    behavior?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: Record<string, unknown>;
    interrupt?: boolean;
    message?: string;
  } = {};
  if (raw.behavior !== undefined) {
    if (typeof raw.behavior === "string") {
      decision.behavior = raw.behavior;
    } else {
      invalid.push("decision.behavior must be a string");
    }
  }
  if (raw.updatedInput !== undefined) {
    if (isRecord(raw.updatedInput)) {
      decision.updatedInput = raw.updatedInput;
    } else {
      invalid.push("decision.updatedInput must be an object");
    }
  }
  if (raw.updatedPermissions !== undefined) {
    if (isRecord(raw.updatedPermissions)) {
      decision.updatedPermissions = raw.updatedPermissions;
    } else {
      invalid.push("decision.updatedPermissions must be an object");
    }
  }
  if (raw.interrupt !== undefined) {
    if (typeof raw.interrupt === "boolean") {
      decision.interrupt = raw.interrupt;
    } else {
      invalid.push("decision.interrupt must be a boolean");
    }
  }
  if (raw.message !== undefined) {
    if (typeof raw.message === "string") {
      decision.message = raw.message;
    } else {
      invalid.push("decision.message must be a string");
    }
  }
  return decision;
}

function mergeCommonOutputFields(
  raw: Record<string, unknown>,
  output: {
    continueProcessing?: boolean;
    stopReason?: string;
    suppressOutput?: boolean;
    systemMessage?: string;
  },
  invalid: string[],
): void {
  if (raw["continue"] !== undefined) {
    if (typeof raw["continue"] === "boolean") {
      output.continueProcessing = raw["continue"];
    } else {
      invalid.push("continue must be a boolean");
    }
  }
  if (raw.stopReason !== undefined) {
    if (typeof raw.stopReason === "string") {
      output.stopReason = raw.stopReason;
    } else {
      invalid.push("stopReason must be a string");
    }
  }
  if (raw.suppressOutput !== undefined) {
    if (typeof raw.suppressOutput === "boolean") {
      output.suppressOutput = raw.suppressOutput;
    } else {
      invalid.push("suppressOutput must be a boolean");
    }
  }
  if (raw.systemMessage !== undefined) {
    if (typeof raw.systemMessage === "string") {
      output.systemMessage = raw.systemMessage;
    } else {
      invalid.push("systemMessage must be a string");
    }
  }
}

function isHookPermissionBehavior(
  value: unknown,
): value is HookPermissionBehavior {
  return value === "allow" || value === "deny" || value === "ask";
}
