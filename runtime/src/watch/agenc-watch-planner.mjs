function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchPlannerController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchPlannerController requires a ${name} object`);
  }
}

function firstInlineText(sanitizeInlineText, ...values) {
  for (const value of values) {
    const text = sanitizeInlineText(value ?? "");
    if (text) {
      return text;
    }
  }
  return "";
}

function formatMaybeCount(value, noun) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatPlanLength(payload) {
  const explicit = Number(payload?.planLengthChars ?? payload?.planLength ?? payload?.planChars);
  const fromPlan = typeof payload?.plan === "string" ? payload.plan.length : NaN;
  const count = Number.isFinite(explicit) ? explicit : fromPlan;
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  return `${count} chars`;
}

function planLifecycleStepName(payload, sanitizeInlineText, fallback) {
  return firstInlineText(
    sanitizeInlineText,
    payload?.planItemId,
    payload?.stepName,
    payload?.title,
    payload?.requestId,
    fallback,
  );
}

function planTextSnippet(payload, sanitizeInlineText) {
  const raw =
    typeof payload?.finalText === "string"
      ? payload.finalText
      : typeof payload?.delta === "string"
        ? payload.delta
        : typeof payload?.plan === "string"
          ? payload.plan
          : "";
  const text = sanitizeInlineText(raw);
  if (!text) {
    return "";
  }
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function summarizePlanApprovalRequest(payload, sanitizeInlineText) {
  const details = [
    "awaiting user approval",
    formatPlanLength(payload),
    formatMaybeCount(payload?.allowedPromptCount, "requested permission"),
    firstInlineText(sanitizeInlineText, payload?.planFilePath, payload?.filePath),
  ].filter(Boolean);
  return details.join(" - ");
}

function approvalOutcome(payload, sanitizeInlineText) {
  const value = firstInlineText(
    sanitizeInlineText,
    payload?.outcome,
    payload?.decision,
    payload?.action,
    payload?.status,
  ).toLowerCase();
  if (
    value === "approved" ||
    value === "approve" ||
    value === "allowed" ||
    value === "allow" ||
    value === "approved_for_session"
  ) {
    return "approved";
  }
  if (
    value === "denied" ||
    value === "deny" ||
    value === "rejected" ||
    value === "reject" ||
    value === "revise" ||
    value === "no"
  ) {
    return "rejected";
  }
  if (value === "aborted" || value === "abort" || value === "timed_out") {
    return "aborted";
  }
  return value || "completed";
}

function summarizePlanApprovalCompletion(payload, sanitizeInlineText) {
  const outcome = approvalOutcome(payload, sanitizeInlineText);
  const feedback = firstInlineText(sanitizeInlineText, payload?.feedback, payload?.reason);
  const duration = Number(payload?.durationMs);
  const details = [
    outcome === "approved"
      ? "plan approved"
      : outcome === "rejected"
        ? "plan rejected; keep planning"
        : outcome === "aborted"
          ? "plan approval aborted"
          : `plan approval ${outcome}`,
    feedback,
    Number.isFinite(duration) && duration > 0 ? `${Math.round(duration)}ms` : "",
  ].filter(Boolean);
  return details.join(" - ");
}

function summarizeQuestionRequest(payload, sanitizeInlineText) {
  const input =
    payload?.toolInput && typeof payload.toolInput === "object"
      ? payload.toolInput
      : payload?.input && typeof payload.input === "object"
        ? payload.input
        : payload?.args && typeof payload.args === "object"
          ? payload.args
          : payload;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const firstQuestion = questions[0] ?? {};
  const header = firstInlineText(
    sanitizeInlineText,
    firstQuestion.header,
    firstQuestion.question,
  );
  const optionCount = questions.reduce(
    (total, question) => total + (Array.isArray(question?.options) ? question.options.length : 0),
    0,
  );
  return [
    formatMaybeCount(questions.length, "question") || "question requested",
    header,
    formatMaybeCount(optionCount, "option"),
  ].filter(Boolean).join(" - ");
}

function summarizeVerificationResult(payload, sanitizeInlineText) {
  const status = firstInlineText(
    sanitizeInlineText,
    payload?.status,
    payload?.outcome,
    payload?.result,
    payload?.completionState,
  ).toLowerCase();
  const detail = firstInlineText(
    sanitizeInlineText,
    payload?.summary,
    payload?.message,
    payload?.reason,
    payload?.error,
  );
  const label =
    status === "passed" || status === "approved" || status === "completed"
      ? "verification passed"
      : status === "failed" || status === "rejected"
        ? "verification failed"
        : status === "unavailable" || status === "disabled"
          ? "verification unavailable"
          : status
            ? `verification ${status}`
            : "verification result";
  return [label, detail].filter(Boolean).join(" - ");
}

export function createWatchPlannerController(dependencies = {}) {
  const {
    watchState,
    plannerDagNodeCount,
    sessionValuesMatch,
    hydratePlannerDagForLiveSession,
    ingestPlannerDag,
    updatePlannerDagNode,
    retirePlannerDagOpenNodes,
    sanitizeInlineText,
    describeToolStart,
    describeToolResult,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  const requiredFunctions = {
    plannerDagNodeCount,
    sessionValuesMatch,
    hydratePlannerDagForLiveSession,
    ingestPlannerDag,
    updatePlannerDagNode,
    retirePlannerDagOpenNodes,
    sanitizeInlineText,
    describeToolStart,
    describeToolResult,
    nowMs,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    assertFunction(name, value);
  }

  function handlePlannerTraceEvent(type, payload) {
    const stepName = sanitizeInlineText(payload?.stepName ?? "");
    const eventSessionId = sanitizeInlineText(
      payload?.sessionId ?? payload?.parentSessionId ?? "",
    );
    if (
      watchState.sessionId &&
      eventSessionId &&
      !sessionValuesMatch(eventSessionId, watchState.sessionId)
    ) {
      // Accept planner events from child/subagent sessions whose parent
      // matches the watched session — the parentSessionId field carries
      // the originating session when the planner runs inside delegation.
      const parentSessionId = sanitizeInlineText(payload?.parentSessionId ?? "");
      if (!parentSessionId || !sessionValuesMatch(parentSessionId, watchState.sessionId)) {
        return false;
      }
    }
    if (type !== "planner_plan_parsed" && plannerDagNodeCount() <= 1) {
      hydratePlannerDagForLiveSession({ force: plannerDagNodeCount() === 1 });
    }
    switch (type) {
      case "planner_plan_parsed":
        ingestPlannerDag(payload ?? {});
        return true;
      case "planner_pipeline_started":
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        watchState.plannerDagNote =
          sanitizeInlineText(payload?.routeReason ?? "") || watchState.plannerDagNote;
        watchState.plannerDagStatus =
          plannerDagNodeCount() > 0 ? "planned" : watchState.plannerDagStatus;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "planner_step_started":
        updatePlannerDagNode({
          stepName,
          status: "running",
          tool: payload?.tool,
          note: describeToolStart(payload?.tool ?? "tool", payload?.args).title,
        });
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        return true;
      case "planner_step_finished": {
        const isError = payload?.isError === true || typeof payload?.error === "string";
        const toolName = sanitizeInlineText(payload?.tool ?? "tool");
        const descriptor = describeToolResult(
          toolName || "tool",
          payload?.args,
          isError,
          typeof payload?.error === "string" ? payload.error : payload?.result ?? "",
        );
        updatePlannerDagNode({
          stepName,
          status: isError ? "failed" : "completed",
          tool: toolName,
          note: descriptor.title,
        });
        watchState.plannerDagPipelineId =
          sanitizeInlineText(payload?.pipelineId ?? "") || watchState.plannerDagPipelineId;
        return true;
      }
      case "planner_refinement_requested":
        retirePlannerDagOpenNodes(
          "blocked",
          sanitizeInlineText(
            payload?.reason ??
              payload?.routeReason ??
              payload?.verificationRequirementDiagnostics?.[0]?.message ??
              "",
          ) || "planner refinement requested",
        );
        watchState.plannerDagStatus = "blocked";
        watchState.plannerDagNote = sanitizeInlineText(
          payload?.reason ??
            payload?.routeReason ??
            payload?.verificationRequirementDiagnostics?.[0]?.message ??
            "",
        ) || "planner refinement requested";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "plan_mode_enter_requested":
      case "enter_plan_mode_requested":
        updatePlannerDagNode({
          stepName: "Enter plan mode",
          status: "blocked",
          tool: "EnterPlanMode",
          stepType: "synthesis",
          note: "awaiting permission to enter plan mode",
        });
        watchState.plannerDagStatus = "blocked";
        watchState.plannerDagNote = "awaiting permission to enter plan mode";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "plan_mode_entered":
      case "plan_entered":
        updatePlannerDagNode({
          stepName: "Enter plan mode",
          status: "completed",
          tool: "EnterPlanMode",
          stepType: "synthesis",
          note: "entered plan mode; no code changes until approval",
        });
        watchState.plannerDagStatus = "running";
        watchState.plannerDagNote = "plan mode active";
        watchState.runPhase = "planning";
        watchState.runState = "planning";
        watchState.activeRunStartedAtMs = watchState.activeRunStartedAtMs ?? nowMs();
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "plan_mode_enter_rejected":
      case "enter_plan_mode_rejected":
        updatePlannerDagNode({
          stepName: "Enter plan mode",
          status: "cancelled",
          tool: "EnterPlanMode",
          stepType: "synthesis",
          note: "user declined to enter plan mode",
        });
        watchState.plannerDagStatus = "cancelled";
        watchState.plannerDagNote = "user declined to enter plan mode";
        watchState.runPhase = null;
        watchState.runState = "idle";
        watchState.activeRunStartedAtMs = null;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "plan_started": {
        const stepName = planLifecycleStepName(payload, sanitizeInlineText, "Plan draft");
        updatePlannerDagNode({
          stepName,
          status: "running",
          tool: "Plan Mode",
          stepType: "synthesis",
          note: "drafting implementation plan",
        });
        watchState.plannerDagStatus = "running";
        watchState.plannerDagNote = "plan mode active";
        watchState.runPhase = "planning";
        watchState.runState = "planning";
        watchState.activeRunStartedAtMs = watchState.activeRunStartedAtMs ?? nowMs();
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_delta": {
        const stepName = planLifecycleStepName(payload, sanitizeInlineText, "Plan draft");
        const snippet = planTextSnippet(payload, sanitizeInlineText);
        updatePlannerDagNode({
          stepName,
          status: "running",
          tool: "Plan Mode",
          stepType: "synthesis",
          note: snippet || "drafting implementation plan",
        });
        watchState.plannerDagStatus = "running";
        watchState.plannerDagNote = snippet || "drafting implementation plan";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_item_completed": {
        const stepName = planLifecycleStepName(payload, sanitizeInlineText, "Plan draft");
        const snippet = planTextSnippet(payload, sanitizeInlineText);
        updatePlannerDagNode({
          stepName,
          status: "completed",
          tool: "Plan Mode",
          stepType: "synthesis",
          note: snippet ? `plan ready: ${snippet}` : "plan ready for approval",
        });
        watchState.plannerDagStatus = "planned";
        watchState.plannerDagNote = "plan ready for approval";
        watchState.runPhase = "planning";
        watchState.runState = "needs_approval";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_approval_requested": {
        const note = summarizePlanApprovalRequest(payload, sanitizeInlineText);
        updatePlannerDagNode({
          stepName: "Plan approval",
          status: "blocked",
          tool: "ExitPlanMode",
          stepType: "synthesis",
          note: note || "awaiting user approval",
        });
        watchState.plannerDagStatus = "blocked";
        watchState.plannerDagNote = note || "awaiting user approval";
        watchState.runPhase = "planning";
        watchState.runState = "needs_approval";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_approval_completed": {
        const outcome = approvalOutcome(payload, sanitizeInlineText);
        const note = summarizePlanApprovalCompletion(payload, sanitizeInlineText);
        const approved = outcome === "approved";
        updatePlannerDagNode({
          stepName: "Plan approval",
          status: approved ? "completed" : "blocked",
          tool: "ExitPlanMode",
          stepType: "synthesis",
          note,
        });
        if (approved) {
          retirePlannerDagOpenNodes("completed", note);
          watchState.plannerDagStatus = "completed";
          watchState.runPhase = null;
          watchState.runState = "idle";
          watchState.activeRunStartedAtMs = null;
        } else {
          watchState.plannerDagStatus = "blocked";
          watchState.runPhase = "planning";
          watchState.runState = "planning";
        }
        watchState.plannerDagNote = note;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "ask_user_question_requested":
      case "ask_user_question_pending": {
        const note = summarizeQuestionRequest(payload, sanitizeInlineText);
        updatePlannerDagNode({
          stepName: "Clarify requirements",
          status: "blocked",
          tool: "AskUserQuestion",
          stepType: "synthesis",
          note,
        });
        watchState.plannerDagStatus = "blocked";
        watchState.plannerDagNote = note;
        watchState.runPhase = "planning";
        watchState.runState = "needs_answer";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "ask_user_question_answered": {
        const note = firstInlineText(
          sanitizeInlineText,
          payload?.summary,
          payload?.answerSummary,
          "questions answered",
        );
        updatePlannerDagNode({
          stepName: "Clarify requirements",
          status: "completed",
          tool: "AskUserQuestion",
          stepType: "synthesis",
          note,
        });
        watchState.plannerDagStatus = "running";
        watchState.plannerDagNote = note;
        watchState.runPhase = "planning";
        watchState.runState = "planning";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_verification_started":
      case "verify_plan_execution_started":
        updatePlannerDagNode({
          stepName: "Verify plan execution",
          status: "running",
          tool: "VerifyPlanExecution",
          stepType: "synthesis",
          note: "verification running",
        });
        watchState.plannerDagStatus = "running";
        watchState.plannerDagNote = "verification running";
        watchState.runPhase = "verification";
        watchState.runState = "running";
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "plan_verification_completed":
      case "verify_plan_execution_completed": {
        const note = summarizeVerificationResult(payload, sanitizeInlineText);
        const normalized = note.toLowerCase();
        const status =
          normalized.includes("failed") || normalized.includes("rejected")
            ? "failed"
            : normalized.includes("unavailable") || normalized.includes("disabled")
              ? "needs_verification"
              : "completed";
        updatePlannerDagNode({
          stepName: "Verify plan execution",
          status,
          tool: "VerifyPlanExecution",
          stepType: "synthesis",
          note,
        });
        watchState.plannerDagStatus = status;
        watchState.plannerDagNote = note;
        watchState.runPhase = null;
        watchState.runState = status === "completed" ? "idle" : status;
        watchState.activeRunStartedAtMs = null;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      case "plan_exited":
      case "plan_mode_exited":
        retirePlannerDagOpenNodes("completed", "exited plan mode");
        watchState.plannerDagStatus = "completed";
        watchState.plannerDagNote = "exited plan mode";
        watchState.runPhase = null;
        watchState.runState = "idle";
        watchState.activeRunStartedAtMs = null;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      case "planner_pipeline_finished":
      case "planner_path_finished": {
        const completionState = sanitizeInlineText(payload?.completionState ?? "");
        const stopReason = sanitizeInlineText(
          payload?.stopReason ?? payload?.stopReasonHint ?? "",
        );
        const stopReasonDetail = sanitizeInlineText(
          payload?.stopReasonDetail ??
            payload?.error ??
            payload?.diagnostics?.[0]?.message ??
            payload?.reason ??
            "",
        );
        const terminalPlannerStatus =
          completionState === "completed"
            ? "completed"
            : completionState === "partial"
              ? "partial"
              : completionState === "needs_verification"
                ? "needs_verification"
                : completionState === "blocked"
                  ? "blocked"
                  : stopReason === "completed"
                    ? "completed"
                    : stopReason === "cancelled"
                      ? "cancelled"
                      : "failed";
        retirePlannerDagOpenNodes(
          terminalPlannerStatus,
          stopReasonDetail ||
            (
              completionState
                ? completionState.replace(/_/g, " ")
                : stopReason
                  ? stopReason.replace(/_/g, " ")
                  : "planner path finished"
            ),
        );
        if (completionState) {
          watchState.plannerDagStatus = terminalPlannerStatus;
        } else if (stopReason) {
          watchState.plannerDagStatus =
            stopReason === "completed"
              ? "completed"
              : stopReason === "cancelled"
                ? "cancelled"
                : "failed";
        }
        const terminalStopReason = new Set(["", "completed", "cancelled", "failed", "validation_error", "timeout"]);
        const terminalCompletionState = new Set([
          "completed",
          "partial",
          "blocked",
          "needs_verification",
        ]);
        watchState.runPhase = null;
        watchState.runState =
          completionState ||
          (terminalStopReason.has(stopReason) ? "idle" : stopReason);
        if (terminalCompletionState.has(completionState) || terminalStopReason.has(stopReason)) {
          watchState.activeRunStartedAtMs = null;
        }
        watchState.plannerDagNote = stopReasonDetail || watchState.plannerDagNote;
        watchState.plannerDagUpdatedAt = nowMs();
        return true;
      }
      default:
        return false;
    }
  }

  return {
    handlePlannerTraceEvent,
  };
}
