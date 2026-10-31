/**
 * What an AgenC Core 0.19.25 runtime accepts in a journal's turn context,
 * frozen for compatibility tests.
 *
 * Copied from 0.19.25 (commit 1e4cf9c35): runtime/src/state/recovery-journal-schema.ts
 * (`isTurnContext` and the validators it uses: `objectShape`, `arrayOf`,
 * `oneOf`, `literal`, `isPlainRecord`, `isFileSystemSandboxPolicy`,
 * `isCollaborationMode`, `isInstructionEvidence`) with
 * `RUN_RUNTIME_REASONING_EFFORTS` from runtime/src/contracts/run-contracts.ts,
 * and the record envelope rules of runtime/src/state/recovery-journal-contract.ts
 * (`KNOWN_CANONICAL_TYPES`, payload must be an object). Do not update it from
 * newer sources: it stands for the runtime a newer journal must stay readable by.
 */

type Check = (value: unknown) => boolean;

const RUN_RUNTIME_REASONING_EFFORTS_0_19_25 = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
] as const;

export const KNOWN_CANONICAL_TYPES_0_19_25: ReadonlySet<string> = new Set([
  "session_meta",
  "session_state",
  "response_item",
  "compacted",
  "turn_context",
  "event_msg",
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger: Check = (value) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isUnknown: Check = () => true;

function objectShape(
  required: Readonly<Record<string, Check>>,
  optional: Readonly<Record<string, Check>> = {},
): Check {
  return (value) => {
    if (!isPlainRecord(value)) return false;
    for (const [field, validator] of Object.entries(required)) {
      if (!Object.hasOwn(value, field) || !validator(value[field])) return false;
    }
    for (const [field, validator] of Object.entries(optional)) {
      if (Object.hasOwn(value, field) && !validator(value[field])) return false;
    }
    // Journal schemas are additive: unknown fields written by a newer runtime
    // remain replayable, while every field known to this runtime is validated.
    return true;
  };
}

function arrayOf(item: Check): Check {
  return (value) => Array.isArray(value) && value.every((entry) => item(entry));
}

function oneOf(...values: readonly (string | number | boolean)[]): Check {
  const accepted = new Set<unknown>(values);
  return (value) => accepted.has(value);
}

function literal(expected: string): Check {
  return (value) => value === expected;
}

const isStringArray = arrayOf(isString);

const isFileSystemSandboxPolicy = objectShape({
  allowWrite: isStringArray,
  denyWrite: isStringArray,
  allowRead: isStringArray,
  denyRead: isStringArray,
});

const isCollaborationMode = objectShape(
  { model: isString },
  {
    reasoningEffort: oneOf(...RUN_RUNTIME_REASONING_EFFORTS_0_19_25),
    developerInstructions: isString,
  },
);

const isInstructionSourceEvidence = objectShape({
  tier: oneOf("managed", "user", "project", "local"),
  path: isString,
  scope: oneOf("machine", "user", "workspace"),
  scopePath: isString,
  precedence: isNonNegativeInteger,
  sourceOrder: isNonNegativeInteger,
  repositoryControlled: isBoolean,
  authority: literal("guidance_only"),
});

const INSTRUCTION_PRECEDENCE = [
  "managed",
  "user",
  "project",
  "local",
  "trusted_internal",
] as const;

const isInstructionPrecedence: Check = (value) =>
  Array.isArray(value) &&
  value.length === INSTRUCTION_PRECEDENCE.length &&
  INSTRUCTION_PRECEDENCE.every((tier, index) => value[index] === tier);

const isInstructionEvidence = objectShape({
  policy: oneOf("workspace_agent", "workspace_review", "isolated"),
  precedence: isInstructionPrecedence,
  sources: arrayOf(isInstructionSourceEvidence),
  repositoryContentAuthority: literal("guidance_only"),
});

/** The 0.19.25 `turn_context` payload validator. */
export const isTurnContext01925: Check = objectShape(
  {
    cwd: isString,
    approvalPolicy: isString,
    sandboxPolicy: isString,
    model: isString,
  },
  {
    turnId: isString,
    traceId: isString,
    currentDate: isString,
    timezone: isString,
    fileSystemSandboxPolicy: isFileSystemSandboxPolicy,
    modelContextWindow: isNumber,
    rawModelContextWindow: isNumber,
    modelEffectiveContextWindowPercent: isNumber,
    autoCompactTokenLimit: isNumber,
    modelProviderId: isString,
    personality: oneOf("none", "friendly", "pragmatic"),
    collaborationMode: isCollaborationMode,
    realtimeActive: isBoolean,
    effort: isString,
    summary: isString,
    userInstructions: isString,
    developerInstructions: isString,
    finalOutputJsonSchema: isUnknown,
    truncationPolicy: oneOf("head", "middle", "off"),
    instructionEvidence: isInstructionEvidence,
  },
);

/** The field names 0.19.25 validates in a turn context; others it ignores. */
export const TURN_CONTEXT_FIELDS_0_19_25: ReadonlySet<string> = new Set([
  "cwd", "approvalPolicy", "sandboxPolicy", "model", "turnId", "traceId",
  "currentDate", "timezone", "fileSystemSandboxPolicy", "modelContextWindow",
  "rawModelContextWindow", "modelEffectiveContextWindowPercent",
  "autoCompactTokenLimit", "modelProviderId", "personality", "collaborationMode",
  "realtimeActive", "effort", "summary", "userInstructions",
  "developerInstructions", "finalOutputJsonSchema", "truncationPolicy",
  "instructionEvidence",
]);

/**
 * Whether 0.19.25 accepts one journal line's record envelope and, for a turn
 * context (as a rollout item or as an event), its payload.
 */
export function acceptsJournalLine01925(record: unknown): boolean {
  if (!isPlainRecord(record)) return false;
  if (typeof record.type !== "string" || !KNOWN_CANONICAL_TYPES_0_19_25.has(record.type)) {
    return false;
  }
  if (!isPlainRecord(record.payload)) return false;
  if (record.type === "turn_context") return isTurnContext01925(record.payload);
  const msg = record.type === "event_msg" ? record.payload.msg : undefined;
  if (isPlainRecord(msg) && msg.type === "turn_context") {
    return isTurnContext01925(msg.payload);
  }
  return true;
}
