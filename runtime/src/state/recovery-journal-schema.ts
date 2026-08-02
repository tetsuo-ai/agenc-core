import type { EventMsg } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";

type ValueValidator = (value: unknown) => boolean;
type ObjectFields = Readonly<Record<string, ValueValidator>>;
type KnownRolloutItem = Exclude<RolloutItem, { readonly type: "unknown" }>;
type KnownRolloutType = KnownRolloutItem["type"];
type EventPayloadValidators = {
  readonly [T in EventMsg["type"]]: ValueValidator;
};
type RolloutPayloadValidators = {
  readonly [T in KnownRolloutType]: ValueValidator;
};

const LEGACY_EVENT_TYPES = Object.freeze({
  task_started: "turn_started",
  task_complete: "turn_complete",
} as const);

const isString: ValueValidator = (value) => typeof value === "string";
const isBoolean: ValueValidator = (value) => typeof value === "boolean";
const isNumber: ValueValidator = (value) =>
  typeof value === "number" && Number.isFinite(value);
const isInteger: ValueValidator = (value) => Number.isSafeInteger(value);
const isNonNegativeInteger: ValueValidator = (value) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isPositiveInteger: ValueValidator = (value) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isRecord: ValueValidator = isPlainRecord;
const isNullableString = nullable(isString);
const isStringArray = arrayOf(isString);
const isRecordArray = arrayOf(isRecord);

const isMessageContent: ValueValidator = (value) =>
  typeof value === "string" ||
  (Array.isArray(value) &&
    value.every(
      (part) =>
        isPlainRecord(part) &&
        typeof part.type === "string" &&
        (part.text === undefined || typeof part.text === "string"),
    ));

const isToolCall: ValueValidator = objectShape(
  { id: isString, name: isString },
  { arguments: isString },
);

const isResponseItem: ValueValidator = objectShape(
  {
    role: oneOf("system", "developer", "user", "assistant", "tool"),
    content: isMessageContent,
  },
  {
    toolCalls: arrayOf(isToolCall),
    toolCallId: isString,
    toolName: isString,
    id: isString,
    endTurn: isBoolean,
    phase: isString,
  },
);

const isSessionAgentTask: ValueValidator = objectShape({
  agentRuntimeId: isString,
  taskId: isString,
  registeredAt: isString,
});

const isFileSystemSandboxPolicy: ValueValidator = objectShape({
  allowWrite: isStringArray,
  denyWrite: isStringArray,
  allowRead: isStringArray,
  denyRead: isStringArray,
});

const isCollaborationMode: ValueValidator = objectShape(
  { model: isString },
  {
    reasoningEffort: oneOf("low", "medium", "high", "xhigh", "none"),
    developerInstructions: isString,
  },
);

const isInstructionSourceEvidence: ValueValidator = objectShape({
  tier: oneOf("managed", "user", "project", "local"),
  path: isString,
  scope: oneOf("machine", "user", "workspace"),
  scopePath: isString,
  precedence: isNonNegativeInteger,
  sourceOrder: isNonNegativeInteger,
  repositoryControlled: isBoolean,
  authority: literal("guidance_only"),
});

const isInstructionEvidence: ValueValidator = objectShape({
  policy: oneOf("workspace_agent", "workspace_review", "isolated"),
  precedence: arrayOf(isString),
  sources: arrayOf(isInstructionSourceEvidence),
  repositoryContentAuthority: literal("guidance_only"),
});

const isTurnContext: ValueValidator = objectShape(
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
    finalOutputJsonSchema: () => true,
    truncationPolicy: oneOf("head", "middle", "off"),
    instructionEvidence: isInstructionEvidence,
  },
);

const isWorktreeLocator: ValueValidator = objectShape({
  path: isString,
  branch: isString,
  gitRoot: isString,
});

const isQuestionOption: ValueValidator = objectShape({
  label: isString,
  description: isString,
});

const isRequestUserInputQuestion: ValueValidator = objectShape(
  {
    id: isString,
    header: isString,
    question: isString,
    isOther: isBoolean,
    isSecret: isBoolean,
  },
  { options: arrayOf(isQuestionOption) },
);

const isClientAction: ValueValidator = objectShape(
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

const isMcpElicitationRequest: ValueValidator = (value) => {
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

const isCheckpointSlice: ValueValidator = objectShape(
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
    pendingBudgetDecision: (value) =>
      isPlainRecord(value) &&
      ((value.kind === "continue" && isNumber(value.remaining)) ||
        (value.kind === "stop" && isString(value.reason))),
  },
);

const isProtocolFact: ValueValidator = objectShape({
  label: isString,
  value: either(isString, isNumber, isBoolean),
});

const isCollabAgentRef: ValueValidator = objectShape(
  { threadId: isString },
  {
    agentPath: isString,
    agentNickname: isString,
    agentRole: isString,
    agentRoleDisplayName: isString,
  },
);

const isAgentStatus: ValueValidator = isString;

const EVENT_PAYLOAD_VALIDATORS = {
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
    { message: isMessageContent },
    {
      displayText: isString,
      images: isStringArray,
      queuedCommandUuid: isString,
      messageId: isString,
      streamId: isString,
      acceptedAt: isString,
    },
  ),
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
    { source: isString, reason: isString },
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
      worktreeEvidence: isRecord,
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
  turn_checkpoint: objectShape({
    turnId: isString,
    iterationIndex: isNonNegativeInteger,
    boundary: oneOf("iteration", "postAssistant"),
    checkpointSeq: isPositiveInteger,
    persistedMessageCount: isNonNegativeInteger,
    prefixHash: isString,
    resumableState: isCheckpointSlice,
  }),
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
      recoveryCategory: isString,
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
      recoveryCategory: isString,
      intentEventSeq: isPositiveInteger,
      outcome: oneOf("committed", "failed", "cancelled"),
      recordedAt: isString,
    },
    {
      formatVersion: literal(2),
      minimumReaderRuntime: isString,
      idempotencyKey: isString,
      effectBoundary: oneOf("not_crossed", "crossed"),
      noEffectEvidence: isRecord,
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
      recoveryCategory: isString,
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
  effect_review_resolved: objectShape({
    runId: isString,
    stepId: isString,
    callId: isString,
    resolution: either(isString, isRecord),
  }),
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
    usage: nullable(isRecord),
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
      event: isString,
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
    { id: isString, turnId: isString, status: isString, action: isString },
    {
      targetItemId: isString,
      riskLevel: isString,
      userAuthorization: isString,
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
      verdict: isString,
      reason: isString,
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
      outcome: isString,
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
      status: isString,
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
      statuses: isRecord,
    },
    { timedOut: isBoolean, agentStatuses: isRecordArray },
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
    reviewOutput: isRecord,
    modelUsed: isString,
    request: isRecord,
  }),
} satisfies EventPayloadValidators;

const ROLLOUT_PAYLOAD_VALIDATORS = {
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
  turn_context: isTurnContext,
  event_msg: objectShape(
    {
      id: isString,
      msg: objectShape({ type: isString, payload: isRecord }),
    },
    { eventId: isString, seq: isPositiveInteger },
  ),
} satisfies RolloutPayloadValidators;

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

function isEventMessage(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  return isCanonicalEventPayload(value.type, value.payload);
}

function isKnownRolloutType(type: string): type is KnownRolloutType {
  return Object.hasOwn(ROLLOUT_PAYLOAD_VALIDATORS, type);
}

function objectShape(
  required: ObjectFields,
  optional: ObjectFields = {},
): ValueValidator {
  return (value) => {
    if (!isPlainRecord(value)) return false;
    for (const [field, validator] of Object.entries(required)) {
      if (!Object.hasOwn(value, field) || !validator(value[field]))
        return false;
    }
    for (const [field, validator] of Object.entries(optional)) {
      if (Object.hasOwn(value, field) && !validator(value[field])) return false;
    }
    // Additive fields are intentionally preserved for same-version producer
    // evolution; every field owned by the current schema is still validated.
    return true;
  };
}

function arrayOf(itemValidator: ValueValidator): ValueValidator {
  return (value) =>
    Array.isArray(value) && value.every((item) => itemValidator(item));
}

function nullable(validator: ValueValidator): ValueValidator {
  return (value) => value === null || validator(value);
}

function either(...validators: readonly ValueValidator[]): ValueValidator {
  return (value) => validators.some((validator) => validator(value));
}

function literal<T extends string | number | boolean>(
  expected: T,
): ValueValidator {
  return (value) => value === expected;
}

function oneOf<Values extends readonly (string | number | boolean)[]>(
  ...values: Values
): ValueValidator {
  const accepted = new Set<unknown>(values);
  return (value) => accepted.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
