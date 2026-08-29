import type { EventMsg } from "../session/event-log.js";
import type {
  RunResumeReason,
  RunRuntimeModelVerbosity,
  RunRuntimePermissionMode,
  RunRuntimeReasoningEffort,
  RunRuntimeServiceTier,
  RunRuntimeSettingsChangeReason,
  RunSuspensionReason,
} from "../contracts/run-contracts.js";
import type { RolloutItem } from "../session/rollout-item.js";
import {
  readCompactionRolloutPayload,
  type CompactionRolloutType,
} from "../session/compaction-event-reader.js";

type KnownRolloutItem = Exclude<RolloutItem, { readonly type: "unknown" }>;
type KnownRolloutType = KnownRolloutItem["type"];
type EventPayload<T extends EventMsg["type"]> = Extract<
  EventMsg,
  { readonly type: T }
>["payload"];
type RolloutPayload<T extends KnownRolloutType> = Extract<
  KnownRolloutItem,
  { readonly type: T }
>["payload"];
declare const VALIDATED_FIELDS: unique symbol;
type AllKeys<T> = T extends unknown ? keyof T : never;
type Validator<T, Fields extends PropertyKey = never> = ((
  value: unknown,
) => value is T) & { readonly [VALIDATED_FIELDS]?: Fields };
type AnyValidator = Validator<unknown, PropertyKey>;
type ObjectFields = Readonly<Record<string, AnyValidator>>;
type ValidatedValue<V> = V extends Validator<infer T, PropertyKey> ? T : never;
type ValidatedFields<V> =
  V extends Validator<unknown, infer Fields> ? Fields : never;
type ValidatedObject<Fields extends ObjectFields> = {
  readonly [Field in keyof Fields]: ValidatedValue<Fields[Field]>;
};
type ValidatedObjectShape<
  Required extends ObjectFields,
  Optional extends ObjectFields,
> = ValidatedObject<Required> & Partial<ValidatedObject<Optional>>;
type ExactFieldMatch<T, V> =
  Exclude<AllKeys<T>, ValidatedFields<V>> extends never
    ? Exclude<ValidatedFields<V>, AllKeys<T>> extends never
      ? true
      : false
    : false;
type EventValidatorChecks<
  Validators extends Record<EventMsg["type"], AnyValidator>,
> = {
  readonly [T in EventMsg["type"]]: Validators[T] extends Validator<
    EventPayload<T>,
    PropertyKey
  >
    ? ExactFieldMatch<EventPayload<T>, Validators[T]> extends true
      ? unknown
      : never
    : never;
};
type RolloutValidatorChecks<
  Validators extends Record<KnownRolloutType, AnyValidator>,
> = {
  readonly [T in KnownRolloutType]: Validators[T] extends Validator<
    RolloutPayload<T>,
    PropertyKey
  >
    ? ExactFieldMatch<RolloutPayload<T>, Validators[T]> extends true
      ? unknown
      : never
    : never;
};

function defineEventPayloadValidators<
  const Validators extends Record<EventMsg["type"], AnyValidator>,
>(validators: Validators & EventValidatorChecks<Validators>): Validators {
  return validators;
}

function defineRolloutPayloadValidators<
  const Validators extends Record<KnownRolloutType, AnyValidator>,
>(validators: Validators & RolloutValidatorChecks<Validators>): Validators {
  return validators;
}

function compactionPayloadValidator<T extends CompactionRolloutType>(
  type: T,
): Validator<RolloutPayload<T>, keyof RolloutPayload<T>> {
  return ((value: unknown): value is RolloutPayload<T> => {
    try {
      readCompactionRolloutPayload(type, value);
      return true;
    } catch {
      return false;
    }
  }) as Validator<RolloutPayload<T>, keyof RolloutPayload<T>>;
}

const LEGACY_EVENT_TYPES = Object.freeze({
  task_started: "turn_started",
  task_complete: "turn_complete",
} as const);

const isString: Validator<string> = (value): value is string =>
  typeof value === "string";
const isRunSuspensionReason: Validator<RunSuspensionReason> = (
  value,
): value is RunSuspensionReason => value === "daemon_shutdown_idle";
const isRunResumeReason: Validator<RunResumeReason> = (
  value,
): value is RunResumeReason =>
  value === "daemon_startup_restore" || value === "explicit_continue";
const isRunRuntimePermissionMode: Validator<RunRuntimePermissionMode> = (
  value,
): value is RunRuntimePermissionMode =>
  value === "default" ||
  value === "plan" ||
  value === "acceptEdits" ||
  value === "bypassPermissions" ||
  value === "dontAsk" ||
  value === "auto" ||
  value === "unattended";
const isRunRuntimeReasoningEffort: Validator<RunRuntimeReasoningEffort> = (
  value,
): value is RunRuntimeReasoningEffort =>
  value === "minimal" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh" ||
  value === "none";
const isRunRuntimeModelVerbosity: Validator<RunRuntimeModelVerbosity> = (
  value,
): value is RunRuntimeModelVerbosity =>
  value === "low" || value === "medium" || value === "high";
const isRunRuntimeServiceTier: Validator<RunRuntimeServiceTier> = (
  value,
): value is RunRuntimeServiceTier =>
  value === "fast" || value === "priority" || value === "flex";
const isRunRuntimeSettingsChangeReason: Validator<
  RunRuntimeSettingsChangeReason
> = (value): value is RunRuntimeSettingsChangeReason =>
  value === "initial" ||
  value === "permission_mode_changed" ||
  value === "model_provider_changed" ||
  value === "config_applied" ||
  value === "hooks_changed" ||
  value === "compensating_rollback";
const isBoolean: Validator<boolean> = (value): value is boolean =>
  typeof value === "boolean";
const isNumber: Validator<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isInteger: Validator<number> = (value): value is number =>
  Number.isSafeInteger(value);
const isNonNegativeInteger: Validator<number> = (value): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isPositiveInteger: Validator<number> = (value): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isRecord: Validator<Record<string, unknown>> = isPlainRecord;
const isUnknown: Validator<unknown> = (_value): _value is unknown => true;
const isNullableString = nullable(isString);
const isStringArray = arrayOf(isString);

type UserMessageContent = EventPayload<"user_message">["message"];
const isLlmTextPart = objectShape({ type: literal("text"), text: isString });
const isLlmImagePart = objectShape({
  type: literal("image_url"),
  image_url: objectShape({ url: isString }),
});
const isLlmDocumentPart = objectShape(
  {
    type: literal("document"),
    source: objectShape({
      type: literal("base64"),
      media_type: literal("application/pdf"),
      data: isString,
    }),
  },
  {
    title: isString,
    filename: isString,
    fallbackText: isString,
    fallbackTextTruncated: isBoolean,
    fallbackTextError: isString,
  },
);
const isLlmContentPart = either(
  isLlmTextPart,
  isLlmImagePart,
  isLlmDocumentPart,
);
const isUserMessageContent: Validator<UserMessageContent> = (
  value,
): value is UserMessageContent =>
  isString(value) ||
  (Array.isArray(value) && value.every((part) => isLlmContentPart(part)));

type ResponseItemContent = RolloutPayload<"response_item">["content"];

const isMessageContent: Validator<ResponseItemContent> = (
  value,
): value is ResponseItemContent =>
  typeof value === "string" ||
  (Array.isArray(value) &&
    value.every(
      (part) =>
        isPlainRecord(part) &&
        typeof part.type === "string" &&
        (part.text === undefined || typeof part.text === "string"),
    ));

const isToolCall = objectShape(
  { id: isString, name: isString },
  { arguments: isString },
);

const isResponseItemShape = objectShape(
  {
    role: oneOf("system", "developer", "user", "assistant", "tool"),
    content: isMessageContent,
  },
  {
    toolCalls: arrayOf(isToolCall),
    toolCallId: isString,
    toolName: isString,
    // The recovery envelope is additive. The checkpoint-v2 reader validates
    // the exact integrity shape, body digest, and owning run before replay.
    toolResultIntegrity: isUnknown,
    // The strict checkpoint reader authenticates the three-channel sequence,
    // reader version, envelope digest, and per-channel content identity.
    agentInvocation: isUnknown,
    id: isString,
    endTurn: isBoolean,
    phase: isString,
  },
);

type ResponseItemPayload = RolloutPayload<"response_item">;
const isResponseItem: Validator<
  ResponseItemPayload,
  AllKeys<ResponseItemPayload>
> = (value): value is ResponseItemPayload => isResponseItemShape(value);

const isSessionAgentTask = objectShape({
  agentRuntimeId: isString,
  taskId: isString,
  registeredAt: isString,
});

const isFileSystemSandboxPolicy = objectShape({
  allowWrite: isStringArray,
  denyWrite: isStringArray,
  allowRead: isStringArray,
  denyRead: isStringArray,
});

const isCollaborationMode = objectShape(
  { model: isString },
  {
    reasoningEffort: oneOf("low", "medium", "high", "xhigh", "none"),
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

type InstructionEvidencePayload = NonNullable<
  EventPayload<"turn_context">["instructionEvidence"]
>;
const INSTRUCTION_PRECEDENCE = [
  "managed",
  "user",
  "project",
  "local",
  "trusted_internal",
] as const;
const isInstructionPrecedence: Validator<
  InstructionEvidencePayload["precedence"]
> = (value): value is InstructionEvidencePayload["precedence"] =>
  Array.isArray(value) &&
  value.length === INSTRUCTION_PRECEDENCE.length &&
  INSTRUCTION_PRECEDENCE.every((tier, index) => value[index] === tier);

const isInstructionEvidence = objectShape({
  policy: oneOf("workspace_agent", "workspace_review", "isolated"),
  precedence: isInstructionPrecedence,
  sources: arrayOf(isInstructionSourceEvidence),
  repositoryContentAuthority: literal("guidance_only"),
});

const isTurnContext = objectShape(
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

const isWorktreeLocator = objectShape({
  path: isString,
  branch: isString,
  gitRoot: isString,
});

const isQuestionOption = objectShape({
  label: isString,
  description: isString,
});

const isRequestUserInputQuestion = objectShape(
  {
    id: isString,
    header: isString,
    question: isString,
    isOther: isBoolean,
    isSecret: isBoolean,
  },
  { options: arrayOf(isQuestionOption) },
);

const isClientAction = objectShape(
  {
    type: literal("ledger_solana_transfer_v1"),
    source: literal("agenc-core"),
    targetCapability: literal("portal.ledger.solana.sign.v1"),
    network: literal("mainnet-beta"),
    intentId: isString,
    responseNonce: isString,
    to: isString,
    lamports: isString,
    expiresAt: isString,
  },
  { note: isString },
);

const isMcpElicitationRequest: Validator<
  EventPayload<"mcp_elicitation_request">["request"]
> = (value): value is EventPayload<"mcp_elicitation_request">["request"] => {
  if (!isPlainRecord(value) || typeof value.mode !== "string") return false;
  if (value.mode === "form") {
    return objectShape(
      {
        mode: literal("form"),
        message: isString,
        requestedSchema: objectShape(
          { type: literal("object"), properties: isRecord },
          { required: isStringArray },
        ),
      },
      { meta: isRecord },
    )(value);
  }
  if (value.mode === "url") {
    return objectShape(
      {
        mode: literal("url"),
        message: isString,
        elicitationId: isString,
        url: isString,
      },
      { meta: isRecord },
    )(value);
  }
  return false;
};

type PendingBudgetDecision = NonNullable<
  EventPayload<"turn_checkpoint">["resumableState"]["pendingBudgetDecision"]
>;
const isPendingBudgetDecision: Validator<PendingBudgetDecision> = (
  value,
): value is PendingBudgetDecision =>
  isPlainRecord(value) &&
  ((value.kind === "continue" && isNumber(value.remaining)) ||
    (value.kind === "stop" && isString(value.reason)));

const isCheckpointSlice = objectShape(
  {
    turnCount: isNonNegativeInteger,
    recoveryReentryCount: isNonNegativeInteger,
    maxOutputTokensRecoveryCount: isNonNegativeInteger,
    continuationNudgeCount: isNonNegativeInteger,
    stopHookBlockingCount: isNonNegativeInteger,
  },
  {
    planToolRequiredRetryCount: isNonNegativeInteger,
    taskBudgetRemaining: isNumber,
    autoCompactTracking: objectShape({
      compacted: isBoolean,
      turnId: isString,
      turnCounter: isNonNegativeInteger,
      consecutiveFailures: isNonNegativeInteger,
    }),
    transition: objectShape({ reason: isString }),
    pendingBudgetDecision: isPendingBudgetDecision,
  },
);

const isProtocolFact = objectShape({
  label: isString,
  value: either(isString, isNumber, isBoolean),
});

const isCollabAgentRef = objectShape(
  { threadId: isString },
  {
    agentPath: isString,
    agentNickname: isString,
    agentRole: isString,
    agentRoleDisplayName: isString,
  },
);

type AgentStatusPayload = EventPayload<"collab_agent_spawn_end">["status"];
type CollabTaskStatus = Extract<
  EventPayload<"collab_agent_status">["status"],
  string
>;

const isAgentStatus: Validator<AgentStatusPayload> = (
  value,
): value is AgentStatusPayload => {
  if (!isPlainRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "pending_init":
    case "not_found":
      return true;
    case "running":
      return isString(value.turnId) && isNumber(value.startedAtMs);
    case "idle":
      return isString(value.turnId) && isNumber(value.endedAtMs);
    case "completed":
      return (
        isString(value.turnId) &&
        isNumber(value.endedAtMs) &&
        (value.lastMessage === undefined || isString(value.lastMessage))
      );
    case "errored":
      return (
        isString(value.turnId) &&
        isNumber(value.endedAtMs) &&
        isString(value.error)
      );
    case "shutdown":
      return isNumber(value.endedAtMs);
    case "interrupted":
      return (
        isString(value.turnId) &&
        isNumber(value.endedAtMs) &&
        isString(value.reason)
      );
    default:
      return false;
  }
};

const isCollabTaskStatus = oneOf<readonly CollabTaskStatus[]>(
  "pending",
  "running",
  // A keep-alive worker between turns. Emitted as a bare string by
  // registerAgentThreadTask's relabel, unlike the AgentStatus object form.
  "idle",
  "completed",
  "failed",
  "killed",
);
const isCollabStatus = either(isAgentStatus, isCollabTaskStatus);
const isCollabAgentStatusEntry = objectShape(
  { threadId: isString, status: isAgentStatus },
  {
    agentNickname: isString,
    agentRole: isString,
    agentRoleDisplayName: isString,
  },
);

const isWorktreeEvidence = either(
  objectShape({
    state: literal("unverifiable"),
    locator: isWorktreeLocator,
    error: isString,
  }),
  objectShape(
    {
      state: oneOf(
        "committed_clean",
        "unchanged_clean",
        "dirty_uncommitted",
        "diverged",
      ),
      locator: isWorktreeLocator,
      baseCommit: isString,
      headCommit: isString,
      treeHash: isString,
      clean: isBoolean,
      baseIsAncestor: isBoolean,
    },
    { integrationRef: isString },
  ),
);

const isToolRecoveryCategory = oneOf(
  "idempotent",
  "side-effecting",
  "interactive",
);
const isEffectNoEffectProof = objectShape({
  version: literal(1),
  kind: literal("effect_no_effect_proof"),
  evidenceKind: oneOf(
    "provider_receipt",
    "idempotency_lookup",
    "boundary_not_crossed",
  ),
  evidenceRef: isString,
  evidenceSha256: isString,
  observedAt: isString,
});
const isEffectReviewResolution = objectShape(
  {
    version: literal(1),
    kind: literal("effect_review_resolution"),
    disposition: oneOf(
      "confirmed_committed",
      "confirmed_no_effect",
      "remains_unknown",
    ),
    actorKind: oneOf("system_settlement", "operator"),
    actorId: isString,
    evidenceKind: oneOf(
      "provider_receipt",
      "idempotency_lookup",
      "boundary_not_crossed",
      "operator_evidence",
    ),
    evidenceRef: isString,
    evidenceSha256: isString,
    reviewedAt: isString,
    workflowStatus: oneOf("pending", "resolved", "abandoned"),
  },
  {
    domainAction: oneOf("mark_completed", "retry_new_attempt", "abandon_item"),
  },
);
const isEffectReviewResolvedPayload = either(
  objectShape({
    runId: isString,
    stepId: isString,
    callId: isString,
    resolution: isEffectReviewResolution,
  }),
  objectShape({
    runId: isString,
    stepId: isString,
    callId: isString,
    resolution: isString,
    reviewedBy: isString,
    reviewedAt: isString,
  }),
);

const isRunUsageTotals = objectShape({
  inputTokens: isNumber,
  outputTokens: isNumber,
  totalTokens: isNumber,
  costUsd: isNumber,
});

const isReviewRequest = objectShape(
  { target: isString },
  { userFacingHint: isString },
);
const isReviewFinding = objectShape({
  title: isString,
  body: isString,
  confidenceScore: isNumber,
  priority: isNumber,
  codeLocation: objectShape({
    absolutePath: isString,
    lineRange: objectShape({ start: isNumber, end: isNumber }),
  }),
});
const isReviewOutput = objectShape({
  findings: arrayOf(isReviewFinding),
  overallCorrectness: isString,
  overallExplanation: isString,
  overallConfidenceScore: isNumber,
});

const turnCheckpointRequiredFields = {
  turnId: isString,
  iterationIndex: isNonNegativeInteger,
  boundary: oneOf("iteration", "postAssistant"),
  checkpointSeq: isPositiveInteger,
  persistedMessageCount: isNonNegativeInteger,
  prefixHash: isString,
  resumableState: isCheckpointSlice,
} as const;

const isTurnCheckpointShape = objectShape(turnCheckpointRequiredFields, {
  // These fields are additive at the recovery-envelope layer. The durable
  // checkpoint reader performs strict version dispatch and shape validation.
  checkpointVersion: isUnknown,
  toolResultIntegrityVersion: isUnknown,
});

type TurnCheckpointPayload = EventPayload<"turn_checkpoint">;
const isTurnCheckpoint: Validator<
  TurnCheckpointPayload,
  AllKeys<TurnCheckpointPayload>
> = (value): value is TurnCheckpointPayload => isTurnCheckpointShape(value);

const EVENT_PAYLOAD_VALIDATORS = defineEventPayloadValidators({
  session_meta: objectShape(
    {
      sessionId: isString,
      timestamp: isString,
      cwd: isString,
      originator: isString,
      agencVersion: isString,
      rolloutSchemaVersion: isPositiveInteger,
    },
    {
      cliVersion: isString,
      source: isString,
      model: isString,
      modelProvider: isString,
      memoryMode: isString,
    },
  ),
  session_configured: objectShape(
    {
      sessionId: isString,
      model: isString,
      modelProviderId: isString,
      cwd: isString,
      historyLogId: isNonNegativeInteger,
      historyEntryCount: isNonNegativeInteger,
      initialMessages: arrayOf(isEventMessage),
    },
    {
      forkedFromId: isString,
      threadName: isString,
      serviceTier: isString,
      rolloutPath: isString,
    },
  ),
  history_cleared: objectShape({ timestamp: isNumber }),
  transcript_epoch: objectShape({
    reason: oneOf("partial_compact", "rewind", "compaction_rollback"),
  }),
  turn_started: objectShape(
    { turnId: isString },
    {
      startedAt: isNumber,
      modelContextWindow: isNumber,
      collaborationModeKind: isString,
      buildId: isString,
    },
  ),
  turn_context: isTurnContext,
  agent_message: objectShape({ message: isString }),
  agent_message_delta: objectShape({ delta: isString }),
  agent_thinking: objectShape(
    { text: isString },
    {
      redacted: isBoolean,
      kind: oneOf("thinking", "reasoning_summary"),
    },
  ),
  assistant_thinking_block_start: objectShape(
    { index: isNonNegativeInteger, redacted: isBoolean },
    { kind: oneOf("thinking", "reasoning_summary") },
  ),
  assistant_thinking_delta: objectShape(
    { delta: isString, index: isNonNegativeInteger },
    { kind: oneOf("thinking", "reasoning_summary") },
  ),
  assistant_thinking_block_stop: objectShape(
    { index: isNonNegativeInteger },
    { kind: oneOf("thinking", "reasoning_summary") },
  ),
  user_message: objectShape(
    { message: isUserMessageContent },
    {
      displayText: isString,
      images: isStringArray,
      queuedCommandUuid: isString,
      messageId: isString,
      streamId: isString,
      acceptedAt: isString,
    },
  ),
  message_submission: objectShape({
    contentFingerprint: isString,
    messageId: isString,
    streamId: isString,
    acceptedAt: isString,
  }),
  token_count: objectShape(
    {},
    {
      promptTokens: isNumber,
      completionTokens: isNumber,
      totalTokens: isNumber,
      cachedInputTokens: isNumber,
      cacheCreationInputTokens: isNumber,
      reasoningOutputTokens: isNumber,
      webSearchRequests: isNumber,
      model: isString,
      provider: isString,
    },
  ),
  mcp_tool_call_begin: objectShape({
    callId: isString,
    server: isString,
    toolName: isString,
    args: isString,
  }),
  mcp_tool_call_end: objectShape(
    { callId: isString, result: isString, isError: isBoolean },
    { durationMs: isNumber },
  ),
  exec_command_begin: objectShape(
    { callId: isString, command: isString },
    {
      cwd: isString,
      processId: isInteger,
      sessionId: isInteger,
      tty: isBoolean,
    },
  ),
  exec_command_end: objectShape(
    { callId: isString, exitCode: nullable(isInteger) },
    {
      stdout: isString,
      stderr: isString,
      durationMs: isNumber,
      processId: isInteger,
      sessionId: isInteger,
      tty: isBoolean,
    },
  ),
  exec_approval_request: objectShape(
    { callId: isString, command: isString },
    { reason: isString },
  ),
  tool_call_started: objectShape({
    callId: isString,
    toolName: isString,
    args: isString,
  }),
  tool_input_block_start: objectShape({
    callId: isString,
    index: isNonNegativeInteger,
    contentBlock: objectShape({
      type: literal("tool_use"),
      id: isString,
      name: isString,
      input: isRecord,
    }),
  }),
  tool_input_delta: objectShape({
    callId: isString,
    index: isNonNegativeInteger,
    partialJson: isString,
  }),
  tool_call_completed: objectShape(
    { callId: isString, result: isString, isError: isBoolean },
    {
      toolName: isString,
      editorInteractionId: isString,
      metadata: isRecord,
    },
  ),
  tool_progress: objectShape(
    { callId: isString, toolName: isString, chunk: isString },
    {
      stream: oneOf("stdout", "stderr", "status"),
      processId: isInteger,
      at: isNumber,
    },
  ),
  request_permissions: objectShape(
    { callId: isString, toolName: isString, permissions: isStringArray },
    {
      turnId: isString,
      reason: isString,
      input: isRecord,
      planContent: isString,
      planFilePath: isString,
      recordedAt: isString,
    },
  ),
  permission_decision: objectShape(
    {
      runId: isString,
      callId: isString,
      toolName: isString,
      turnId: isString,
      requestEventId: isString,
      requestEventSeq: isPositiveInteger,
      decision: oneOf(
        "approved",
        "approved_execpolicy_amendment",
        "approved_for_session",
        "network_policy_amendment",
        "denied",
        "timed_out",
        "abort",
      ),
      recordedAt: isString,
    },
    {
      source: oneOf(
        "hook",
        "resolver",
        "default_deny",
        "permission_hook",
        "guardian",
        "cache",
        "aborted",
      ),
      reason: isString,
    },
  ),
  request_user_input: objectShape(
    {
      requestId: isString,
      callId: isString,
      turnId: isString,
      questions: arrayOf(isRequestUserInputQuestion),
    },
    { clientAction: isClientAction },
  ),
  mcp_elicitation_request: objectShape({
    turnId: isString,
    serverName: isString,
    requestId: either(isString, isNumber),
    request: isMcpElicitationRequest,
  }),
  mcp_elicitation_complete: objectShape({
    serverName: isString,
    elicitationId: isString,
  }),
  context_compacted: objectShape(
    {},
    {
      turnId: isString,
      summary: isString,
      preCompactTokens: isNumber,
      postCompactTokens: isNumber,
    },
  ),
  subagent_turn_outcome: objectShape(
    {
      agentId: isString,
      agentPath: isString,
      turnId: isString,
      outcome: oneOf("completed", "errored", "interrupted", "nack"),
      toolCallCount: isNonNegativeInteger,
    },
    {
      taskId: isString,
      message: isString,
      reason: isString,
      worktreeEvidence: isWorktreeEvidence,
    },
  ),
  turn_complete: objectShape(
    { turnId: isString },
    {
      taskId: isString,
      toolCallCount: isNonNegativeInteger,
      worktree: isWorktreeLocator,
      lastAgentMessage: isString,
      completedAt: isNumber,
      durationMs: isNumber,
    },
  ),
  turn_aborted: objectShape({ reason: isString }, { turnId: isString }),
  turn_checkpoint: isTurnCheckpoint,
  turn_resumed: objectShape(
    {
      turnId: isString,
      fromCheckpointSeq: isPositiveInteger,
      fromIteration: isNonNegativeInteger,
    },
    { haltedSideEffectingTools: isStringArray },
  ),
  thread_rolled_back: objectShape(
    { numTurns: isNonNegativeInteger },
    { reason: isString },
  ),
  error: objectShape(
    { cause: isString, message: isString },
    { turnId: isString, stack: isString },
  ),
  stream_error: objectShape(
    { cause: isString, message: isString },
    { provider: isString, status: isNumber },
  ),
  warning: objectShape({ cause: isString, message: isString }),
  effect_intent: objectShape(
    {
      runId: isString,
      stepId: isString,
      callId: isString,
      toolName: isString,
      recoveryCategory: isToolRecoveryCategory,
      intentDigest: isString,
      attempt: isPositiveInteger,
      recordedAt: isString,
    },
    {
      formatVersion: literal(2),
      minimumReaderRuntime: isString,
      idempotencyKey: isString,
    },
  ),
  effect_result: objectShape(
    {
      runId: isString,
      stepId: isString,
      callId: isString,
      toolName: isString,
      recoveryCategory: isToolRecoveryCategory,
      intentEventSeq: isPositiveInteger,
      outcome: oneOf("committed", "failed", "cancelled"),
      recordedAt: isString,
    },
    {
      formatVersion: literal(2),
      minimumReaderRuntime: isString,
      idempotencyKey: isString,
      effectBoundary: oneOf("not_crossed", "crossed"),
      noEffectEvidence: isEffectNoEffectProof,
      resultDigest: isString,
      evidence: isRecord,
    },
  ),
  effect_unknown_outcome: objectShape(
    {
      runId: isString,
      stepId: isString,
      callId: isString,
      toolName: isString,
      recoveryCategory: isToolRecoveryCategory,
      intentEventSeq: isPositiveInteger,
      outcome: literal("unknown_outcome"),
      reason: isString,
      requiresReview: literal(true),
      recordedAt: isString,
    },
    {
      formatVersion: literal(2),
      minimumReaderRuntime: isString,
      idempotencyKey: isString,
      callerStop: oneOf("abort", "timeout"),
      callerStoppedAt: isString,
      reservationId: isString,
    },
  ),
  effect_review_resolved: isEffectReviewResolvedPayload,
  artifact_intent: objectShape({
    runId: isString,
    artifactId: isString,
    kind: literal("tool_result"),
    sourceCallId: isString,
    targetPath: isString,
    contentSha256: isString,
    byteLength: isNonNegativeInteger,
    recordedAt: isString,
  }),
  artifact_committed: objectShape({
    runId: isString,
    artifactId: isString,
    kind: literal("tool_result"),
    sourceCallId: isString,
    targetPath: isString,
    contentSha256: isString,
    byteLength: isNonNegativeInteger,
    recordedAt: isString,
    intentEventSeq: isPositiveInteger,
    outcome: oneOf("committed", "already_committed", "recovered"),
    committedAt: isString,
  }),
  run_terminal: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    status: oneOf("completed", "failed", "cancelled", "unknown_outcome"),
    exitCode: nullable(isInteger),
    stopReason: isNullableString,
    finalMessage: isNullableString,
    usage: nullable(isRunUsageTotals),
    lastSequenceBeforeTerminal: nullable(isNonNegativeInteger),
    finishedAt: isString,
  }),
  run_reopened: objectShape({
    runId: isString,
    previousEpoch: isPositiveInteger,
    epoch: isPositiveInteger,
    reason: isString,
    reopenedAt: isString,
  }),
  run_suspended: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    reason: isRunSuspensionReason,
    suspendedAt: isString,
  }),
  run_resumed: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    suspensionEventId: isString,
    reason: isRunResumeReason,
    resumedAt: isString,
  }),
  run_startup_activated: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    resumeEventId: isString,
    activatedAt: isString,
  }),
  run_runtime_settings_changed: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    previousSettingsEventId: nullable(isString),
    rollbackOfSettingsEventId: nullable(isString),
    reason: isRunRuntimeSettingsChangeReason,
    changedAt: isString,
    permissionMode: isRunRuntimePermissionMode,
    prePlanMode: nullable(isRunRuntimePermissionMode),
    autoModeActive: isBoolean,
    autoModeAvailable: isBoolean,
    bypassPermissionsModeAvailable: isBoolean,
    bypassPermissionsWorkspace: nullable(isString),
    bypassPermissionsConsentWorkspace: nullable(isString),
    model: isString,
    provider: isString,
    profile: nullable(isString),
    reasoningEffort: nullable(isRunRuntimeReasoningEffort),
    modelVerbosity: nullable(isRunRuntimeModelVerbosity),
    serviceTier: nullable(isRunRuntimeServiceTier),
    hooksDisabled: isBoolean,
  }),
  run_cancel_requested: objectShape({
    runId: isString,
    epoch: isPositiveInteger,
    reason: isString,
    requestedAt: isString,
  }),
  recovery_decision: objectShape(
    {
      runId: isString,
      decision: oneOf(
        "retry_safe_deferred",
        "projection_rebuilt",
        "artifact_retry_safe_deferred",
        "artifact_conflict_review_required",
      ),
      reason: isString,
      evidenceEventId: isString,
      evidenceEventSeq: isPositiveInteger,
      recordedAt: isString,
    },
    { stepId: isString },
  ),
  execution_admission: objectShape(
    {
      sequence: isPositiveInteger,
      eventId: isString,
      timestamp: isString,
      runId: isString,
      stepId: isString,
      kind: oneOf("model_turn", "tool_exec", "spawn"),
      event: oneOf(
        "queued",
        "allowed",
        "denied",
        "approval_required",
        "dispatched",
        "reconciled",
        "voided",
        "held_unknown",
        "provider_overrun",
        "cancelled",
        "recovered",
        "fallback",
      ),
    },
    {
      reason: isString,
      reservationId: isString,
      model: isString,
      provider: isString,
      reservedCostUsd: isNumber,
      reservedTokens: isNumber,
      actualCostUsd: isNumber,
      actualTokens: isNumber,
      details: isRecord,
    },
  ),
  guardian_assessment: objectShape(
    {
      id: isString,
      turnId: isString,
      status: oneOf(
        "in_progress",
        "approved",
        "denied",
        "timed_out",
        "aborted",
      ),
      action: isString,
    },
    {
      targetItemId: isString,
      riskLevel: oneOf("low", "medium", "high", "critical"),
      userAuthorization: oneOf("unknown", "low", "medium", "high"),
      rationale: isString,
      decisionSource: literal("agent"),
    },
  ),
  review_delegate_started: objectShape(
    {
      subId: isString,
      target: isString,
      modelUsed: isString,
      snapshot_reused: isBoolean,
      priorFindingCount: isNonNegativeInteger,
      startedAt: isNumber,
    },
    { reuseKey: isString },
  ),
  review_delegate_completed: objectShape(
    {
      subId: isString,
      target: isString,
      modelUsed: isString,
      snapshot_reused: isBoolean,
      priorFindingCount: isNonNegativeInteger,
      newFindingCount: isNonNegativeInteger,
      durationMs: isNumber,
      verdict: oneOf("pass", "fail", "partial", "aborted", "timeout"),
      reason: oneOf("completed", "timeout", "aborted", "error"),
      completedAt: isNumber,
    },
    { reuseKey: isString, error: isString },
  ),
  plan_approval_requested: objectShape(
    {
      requestId: isString,
      turnId: isString,
      planLengthChars: isNonNegativeInteger,
      allowedPromptCount: isNonNegativeInteger,
      requestedAt: isNumber,
    },
    { planFilePath: isString },
  ),
  plan_approval_completed: objectShape(
    {
      requestId: isString,
      turnId: isString,
      planLengthChars: isNonNegativeInteger,
      allowedPromptCount: isNonNegativeInteger,
      outcome: oneOf("approved", "approved_for_session", "denied", "aborted"),
      durationMs: isNumber,
      completedAt: isNumber,
    },
    { planFilePath: isString },
  ),
  protocol_claim: objectShape(
    { taskPda: isString },
    {
      claimant: isString,
      escrowLamports: isNumber,
      stakeLamports: isNumber,
      deadline: isString,
      signature: isString,
      message: isString,
      facts: arrayOf(isProtocolFact),
    },
  ),
  protocol_settle: objectShape(
    { taskPda: isString },
    {
      recipient: isString,
      escrowLamports: isNumber,
      bonusLamports: isNumber,
      reputationDelta: isNumber,
      signature: isString,
      message: isString,
      facts: arrayOf(isProtocolFact),
    },
  ),
  protocol_slash: objectShape(
    { taskPda: isString, reason: isString },
    {
      slashedAgent: isString,
      stakeDeltaLamports: isNumber,
      reputationDelta: isNumber,
      signature: isString,
      message: isString,
      facts: arrayOf(isProtocolFact),
    },
  ),
  protocol_stake: objectShape(
    {},
    {
      wallet: isString,
      taskPda: isString,
      stakeLamports: isNumber,
      stakeDeltaLamports: isNumber,
      reputationDelta: isNumber,
      signature: isString,
      message: isString,
      facts: arrayOf(isProtocolFact),
    },
  ),
  collab_agent_spawn_begin: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      prompt: isString,
      model: isString,
    },
    { taskName: isString, agentType: isString, reasoningEffort: isString },
  ),
  collab_agent_spawn_end: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      prompt: isString,
      model: isString,
      status: isAgentStatus,
    },
    {
      newThreadId: isString,
      newAgentPath: isString,
      newAgentNickname: isString,
      newAgentRole: isString,
      newAgentRoleDisplayName: isString,
      taskName: isString,
      agentType: isString,
      reasoningEffort: isString,
    },
  ),
  collab_agent_status: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      threadId: isString,
      status: isCollabStatus,
    },
    {
      agentPath: isString,
      agentNickname: isString,
      agentRole: isString,
      agentRoleDisplayName: isString,
      prompt: isString,
      model: isString,
      reasoningEffort: isString,
      toolUseCount: isNonNegativeInteger,
      tokenCount: isNonNegativeInteger,
      error: isString,
    },
  ),
  collab_agent_interaction_begin: objectShape({
    callId: isString,
    senderThreadId: isString,
    receiverThreadId: isString,
    prompt: isString,
  }),
  collab_agent_interaction_end: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      receiverThreadId: isString,
      prompt: isString,
      status: isAgentStatus,
    },
    {
      receiverAgentNickname: isString,
      receiverAgentRole: isString,
      receiverAgentRoleDisplayName: isString,
    },
  ),
  collab_waiting_begin: objectShape(
    {
      senderThreadId: isString,
      receiverThreadIds: isStringArray,
      callId: isString,
    },
    { receiverAgents: arrayOf(isCollabAgentRef) },
  ),
  collab_waiting_end: objectShape(
    {
      senderThreadId: isString,
      callId: isString,
      statuses: recordOf(isAgentStatus),
    },
    {
      timedOut: isBoolean,
      agentStatuses: arrayOf(isCollabAgentStatusEntry),
    },
  ),
  collab_close_begin: objectShape({
    callId: isString,
    senderThreadId: isString,
    receiverThreadId: isString,
  }),
  collab_close_end: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      receiverThreadId: isString,
      status: isAgentStatus,
    },
    {
      receiverAgentNickname: isString,
      receiverAgentRole: isString,
      receiverAgentRoleDisplayName: isString,
    },
  ),
  collab_resume_begin: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      receiverThreadId: isString,
    },
    {
      receiverAgentNickname: isString,
      receiverAgentRole: isString,
      receiverAgentRoleDisplayName: isString,
    },
  ),
  collab_resume_end: objectShape(
    {
      callId: isString,
      senderThreadId: isString,
      receiverThreadId: isString,
      status: isAgentStatus,
    },
    {
      receiverAgentNickname: isString,
      receiverAgentRole: isString,
      receiverAgentRoleDisplayName: isString,
    },
  ),
  entered_review_mode: objectShape(
    { target: isString },
    { userFacingHint: isString },
  ),
  deprecation_notice: objectShape(
    { subject: isString, reason: isString },
    { replacement: isString, deprecated_since: isString },
  ),
  plan_started: objectShape({
    turnId: isString,
    planItemId: isString,
    title: isString,
    timestamp: isNumber,
  }),
  plan_delta: objectShape({
    turnId: isString,
    planItemId: isString,
    delta: isString,
    timestamp: isNumber,
  }),
  plan_item_completed: objectShape({
    turnId: isString,
    planItemId: isString,
    finalText: isString,
    timestamp: isNumber,
  }),
  plan_exited: objectShape({ turnId: isString, timestamp: isNumber }),
  exit_review_mode: objectShape({
    subId: isString,
    reason: oneOf("aborted", "completed", "timeout"),
    reviewOutput: isReviewOutput,
    modelUsed: isString,
    request: isReviewRequest,
  }),
});

const ROLLOUT_PAYLOAD_VALIDATORS = defineRolloutPayloadValidators({
  session_meta: EVENT_PAYLOAD_VALIDATORS.session_meta,
  session_state: objectShape({}, { agentTask: isSessionAgentTask }),
  response_item: isResponseItem,
  compacted: objectShape(
    { message: isString },
    {
      replacementHistory: arrayOf(isResponseItem),
      preCompactTokens: isNumber,
      postCompactTokens: isNumber,
    },
  ),
  compaction_intent: compactionPayloadValidator("compaction_intent"),
  compaction_payload_chunk: compactionPayloadValidator(
    "compaction_payload_chunk",
  ),
  compaction_failed: compactionPayloadValidator("compaction_failed"),
  compaction_committed: compactionPayloadValidator("compaction_committed"),
  compaction_cleanup_pending: compactionPayloadValidator(
    "compaction_cleanup_pending",
  ),
  compaction_rollback_committed: compactionPayloadValidator(
    "compaction_rollback_committed",
  ),
  compaction_retention_extended: compactionPayloadValidator(
    "compaction_retention_extended",
  ),
  compaction_source_release: compactionPayloadValidator(
    "compaction_source_release",
  ),
  turn_context: isTurnContext,
  event_msg: objectShape(
    {
      id: isString,
      msg: isStoredEventMessage,
    },
    { eventId: isString, seq: isPositiveInteger },
  ),
});

export const CANONICAL_EVENT_SCHEMA_TYPES = Object.freeze(
  Object.keys(EVENT_PAYLOAD_VALIDATORS).sort(),
);

export const CANONICAL_ROLLOUT_SCHEMA_TYPES = Object.freeze(
  Object.keys(ROLLOUT_PAYLOAD_VALIDATORS).sort(),
);

export function isCanonicalRolloutPayload(
  type: string,
  payload: unknown,
): boolean {
  if (!isKnownRolloutType(type)) return false;
  return ROLLOUT_PAYLOAD_VALIDATORS[type](payload);
}

export function isCanonicalEventPayload(
  type: string,
  payload: unknown,
): boolean {
  const canonicalType =
    LEGACY_EVENT_TYPES[type as keyof typeof LEGACY_EVENT_TYPES] ?? type;
  if (!Object.hasOwn(EVENT_PAYLOAD_VALIDATORS, canonicalType)) return false;
  return EVENT_PAYLOAD_VALIDATORS[canonicalType as EventMsg["type"]](payload);
}

function isEventMessage(value: unknown): value is EventMsg {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (!Object.hasOwn(EVENT_PAYLOAD_VALIDATORS, value.type)) return false;
  return EVENT_PAYLOAD_VALIDATORS[value.type as EventMsg["type"]](
    value.payload,
  );
}

/**
 * Accept the two historical top-level event aliases that parseRolloutLine()
 * normalizes before returning a RolloutItem. Nested EventMsg values stay on
 * the current schema through isEventMessage().
 */
function isStoredEventMessage(value: unknown): value is EventMsg {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  return isCanonicalEventPayload(value.type, value.payload);
}

function isKnownRolloutType(type: string): type is KnownRolloutType {
  return Object.hasOwn(ROLLOUT_PAYLOAD_VALIDATORS, type);
}

function objectShape<const Required extends ObjectFields>(
  required: Required,
): Validator<ValidatedObject<Required>, keyof Required>;
function objectShape<
  const Required extends ObjectFields,
  const Optional extends ObjectFields,
>(
  required: Required,
  optional: Optional,
): Validator<
  ValidatedObjectShape<Required, Optional>,
  keyof Required | keyof Optional
>;
function objectShape(
  required: ObjectFields,
  optional: ObjectFields = {},
): Validator<Record<string, unknown>, PropertyKey> {
  return (value): value is Record<string, unknown> => {
    if (!isPlainRecord(value)) return false;
    for (const [field, validator] of Object.entries(required)) {
      if (!Object.hasOwn(value, field) || !validator(value[field]))
        return false;
    }
    for (const [field, validator] of Object.entries(optional)) {
      if (Object.hasOwn(value, field) && !validator(value[field])) return false;
    }
    // Journal schemas are additive: unknown fields written by a newer runtime
    // remain replayable, while every field known to this runtime is validated.
    return true;
  };
}

function arrayOf<T, Fields extends PropertyKey>(
  itemValidator: Validator<T, Fields>,
): Validator<readonly T[]> {
  return (value): value is readonly T[] =>
    Array.isArray(value) && value.every((item) => itemValidator(item));
}

function recordOf<T, Fields extends PropertyKey>(
  valueValidator: Validator<T, Fields>,
): Validator<Record<string, T>> {
  return (value): value is Record<string, T> =>
    isPlainRecord(value) &&
    Object.values(value).every((item) => valueValidator(item));
}

function nullable<T, Fields extends PropertyKey>(
  validator: Validator<T, Fields>,
): Validator<T | null> {
  return (value): value is T | null => value === null || validator(value);
}

function either<const Validators extends readonly AnyValidator[]>(
  ...validators: Validators
): Validator<
  ValidatedValue<Validators[number]>,
  ValidatedFields<Validators[number]>
> {
  return (value): value is ValidatedValue<Validators[number]> =>
    validators.some((validator) => validator(value));
}

function literal<const T extends string | number | boolean>(
  expected: T,
): Validator<T> {
  return (value): value is T => value === expected;
}

function oneOf<const Values extends readonly (string | number | boolean)[]>(
  ...values: Values
): Validator<Values[number]> {
  const accepted = new Set<unknown>(values);
  return (value): value is Values[number] => accepted.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
