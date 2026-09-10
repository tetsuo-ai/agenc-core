import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionStatusLineExecuteResult as SessionStatusLineResult, SessionStatusLinePresentation } from "../app-server/protocol/index.js";
import { AdmissionDeniedError } from "../budget/admission-client.js";
import { mergeConfigLayerSnapshots } from "../config/repository.js";
import { validateStatusLineConfig } from "../config/schema.js";
import { SandboxExecutionError } from "../sandbox/execution-broker.js";
import type { Session } from "../session/session.js";
import { isAdmissionUsageSummary } from "../session/usage-summary.js";
import { VERSION } from "../version.js";
import { asRecord } from "../utils/record.js";
import { workspaceMutationCoordinators, WorkspaceMutationCoordinatorError } from "../workspace/mutation-coordinator.js";
import { createWorkspaceOperationLifetime, runWithWorkspaceOperationLifetime } from "../workspace/tool-operation-lifetime.js";
import { runHookCommand } from "./engine/command-runner.js";

const activeSessions = new WeakSet<Session>();
const TIMEOUT_MS = 5_000;
const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 16_384;
const latestUsageBySession = new WeakMap<Session, { value: ReturnType<typeof contextUsage> }>();

function contextUsage(value: unknown) {
  const payload = asRecord(value);
  if (payload === null || typeof payload.promptTokens !== "number" || typeof payload.completionTokens !== "number") return null;
  const counts = [payload.promptTokens, payload.completionTokens, payload.cachedInputTokens ?? 0, payload.cacheCreationInputTokens ?? 0];
  if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null;
  const cached = Number(counts[2]);
  const created = Number(counts[3]);
  return {
    input_tokens: Math.max(0, payload.promptTokens - cached - created),
    output_tokens: payload.completionTokens,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: created,
  };
}

function latestContextUsage(session: Session) {
  const existing = latestUsageBySession.get(session);
  if (existing !== undefined) return existing.value;
  const initial = session.state.unsafePeek().initialTokenUsage;
  const current = { value: isMainUsage(initial) ? contextUsage(initial) : null };
  const path = session.rolloutStore?.rolloutPath;
  if (path !== undefined) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "r");
      const size = fstatSync(descriptor).size;
      const offset = Math.max(0, size - MAX_INPUT_BYTES);
      const buffer = Buffer.alloc(Math.min(size, MAX_INPUT_BYTES));
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      const lines = buffer.toString("utf8", 0, count).split("\n");
      if (offset > 0) lines.shift();
      for (const line of lines.reverse()) {
        try {
          const item = asRecord(JSON.parse(line));
          const event = asRecord(item?.payload);
          const message = asRecord(event?.msg);
          if (item?.type === "compaction_committed" || item?.type === "compacted" ||
              (item?.type === "event_msg" && contextWasReplaced(message?.type))) {
            current.value = null;
            break;
          }
          if (item?.type === "event_msg" && message?.type === "token_count" && isMainUsage(message.payload)) {
            current.value = contextUsage(message.payload);
            break;
          }
        } catch {}
      }
    } catch {
      current.value = null;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  session.eventLog.subscribe((event) => {
    if (event.msg.type === "token_count" && isMainUsage(event.msg.payload)) current.value = contextUsage(event.msg.payload);
    else if (contextWasReplaced(event.msg.type)) current.value = null;
  });
  latestUsageBySession.set(session, current);
  return current.value;
}

function isMainUsage(value: unknown): boolean {
  const payload = asRecord(value);
  return typeof payload?.provider === "string" && payload.provider.length > 0 &&
    typeof payload.model === "string" && payload.model.length > 0;
}

function contextWasReplaced(type: unknown): boolean {
  return type === "history_cleared" || type === "transcript_epoch" || type === "context_compacted";
}

function executionBlock(session: Session): SessionStatusLineResult | undefined {
  if (session.eventLog.isClosed || session.abortController.signal.aborted ||
      session.services.mcpStartupCancellationToken.isCancelled()) {
    return { status: "unavailable", reason: "session_closed" };
  }
  if (session.services.runtimeOptions.simpleMode || session.services.hooksRuntime?.isDisabled()) {
    return { status: "disabled", reason: "hooks_disabled" };
  }
  const authority = session.services.hookExecutionAuthority;
  if (authority === undefined) return { status: "blocked", reason: "missing_session_authority" };
  const decision = authority.decision("command");
  if (!decision.allowed) return { status: "blocked", reason: decision.reason };
  return undefined;
}

function statusLineInput(session: Session, presentation: SessionStatusLinePresentation): string | undefined {
  const configStore = session.services.configStore;
  const usage = session.services.executionAdmission?.getUsageSummary?.();
  const admission = session.services.executionAdmission;
  if (configStore === undefined || !isAdmissionUsageSummary(usage) ||
      usage.runId !== admission?.scope.runId || admission.scope.sessionId !== session.conversationId) return undefined;
  const config = configStore.current();
  const sidecar = session.services.costSidecar;
  const cwd = session.sessionConfiguration.cwd;
  const projectRoot = configStore.projectRoot;
  if (!isAbsolute(cwd) || !isAbsolute(projectRoot)) return undefined;
  const model = session.sessionConfiguration.collaborationMode.model;
  const currentUsage = latestContextUsage(session);
  const currentInput = currentUsage === null ? null : currentUsage.input_tokens + currentUsage.cache_read_input_tokens + currentUsage.cache_creation_input_tokens;
  const contextWindow = session.modelInfo.contextWindow;
  const usedPercentage = currentInput === null || contextWindow === undefined || contextWindow <= 0
    ? null : Math.max(0, Math.min(100, Math.round(currentInput / contextWindow * 100)));
  const worktree = session.pendingWorktreeState;
  const source = session.sessionConfiguration.sessionSource;
  const agentRole = typeof source === "object" && source.kind === "subagent" && source.source.kind === "thread_spawn"
    ? source.source.agentRole : undefined;
  return JSON.stringify({
    session_id: session.conversationId,
    transcript_path: session.rolloutStore?.rolloutPath ?? "",
    cwd,
    permission_mode: session.services.permissionModeRegistry.current().mode,
    model: { id: model, display_name: model },
    workspace: { current_dir: cwd, project_dir: projectRoot, added_dirs: [...session.services.permissionModeRegistry.current().additionalWorkingDirectories.keys()] },
    version: VERSION,
    output_style: { name: config.outputStyle ?? "default" },
    cost: {
      total_cost_usd: usage.costUsd,
      has_unknown_cost: usage.hasUnknownCost,
      total_duration_ms: sidecar?.getTotalDurationMs() ?? 0,
      total_api_duration_ms: sidecar?.getTotalApiDurationMs() ?? 0,
      total_lines_added: sidecar?.getTotalLinesAdded() ?? 0,
      total_lines_removed: sidecar?.getTotalLinesRemoved() ?? 0,
    },
    context_window: {
      total_input_tokens: usage.inputTokens,
      total_output_tokens: usage.outputTokens,
      context_window_size: session.modelInfo.contextWindow ?? null,
      current_usage: currentUsage,
      used_percentage: usedPercentage,
      remaining_percentage: usedPercentage === null ? null : 100 - usedPercentage,
    },
    exceeds_200k_tokens: currentInput === null ? null : currentInput + currentUsage!.output_tokens > 200_000,
    ...(agentRole !== undefined ? { agent: { name: agentRole } } : {}),
    ...(worktree === null ? {} : { worktree: {
      path: worktree.handle.path,
      branch: worktree.handle.branch,
      original_cwd: worktree.originalCwd,
    } }),
    ...(presentation.vimMode !== undefined ? { vim: { mode: presentation.vimMode } } : {}),
  });
}

async function runSessionStatusLine(
  session: Session,
  presentation: SessionStatusLinePresentation,
  signal: AbortSignal,
): Promise<SessionStatusLineResult> {
  const blocked = executionBlock(session);
  if (blocked !== undefined) return blocked;
  signal.throwIfAborted();
  const configStore = session.services.configStore;
  if (configStore === undefined) return { status: "unavailable", reason: "configuration_unavailable" };
  const config = configStore.current();
  const sessionConfig = session.sessionConfiguration;
  const managed = mergeConfigLayerSnapshots(configStore.sources("managed"));
  if (managed?.disableAllHooks === true) return { status: "disabled", reason: "managed_hooks_disabled" };
  const command = validateStatusLineConfig(
    managed?.allowManagedHooksOnly === true || config.disableAllHooks === true
      ? managed?.statusLine
      : config.statusLine,
  );
  if (command === undefined) return { status: "disabled", reason: "not_configured" };
  const admission = session.services.executionAdmission;
  const broker = session.services.sandboxExecutionBroker;
  const shell = session.services.userShell;
  if (admission === undefined || broker === undefined || shell === undefined) {
    return { status: "blocked", reason: "execution_boundary_unavailable" };
  }
  const input = statusLineInput(session, presentation);
  if (input === undefined) return { status: "unavailable", reason: "session_input_unavailable" };
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) return { status: "error", reason: "input_too_large" };
  const workspaceRegistry = workspaceMutationCoordinators.forHome(configStore.homeContext.path);
  const workspaceToken = workspaceRegistry.beginToolOperation(sessionConfig.cwd, "StatusLine");
  const lifetime = createWorkspaceOperationLifetime(() => workspaceRegistry.endToolOperation(workspaceToken));
  let completedReservationId: string | undefined;
  try {
    return await runWithWorkspaceOperationLifetime(lifetime, async () => {
      const lease = await admission.acquire({
        stepId: `hook:StatusLine:${randomUUID()}`,
        kind: "tool_exec",
        sessionId: session.conversationId,
        parentScopeId: "hook:StatusLine",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }, signal);
      const reservationId = lease.reservation.reservationId;
      completedReservationId = reservationId;
      let dispatched = false;
      let settled = false;
      try {
        const effectSignal = AbortSignal.any([signal, lease.signal]);
        effectSignal.throwIfAborted();
        const blockedAfterAdmission = executionBlock(session);
        if (blockedAfterAdmission !== undefined) return blockedAfterAdmission;
        if (configStore.current() !== config || session.sessionConfiguration !== sessionConfig) return { status: "unavailable", reason: "configuration_changed" };
        const freshInput = statusLineInput(session, presentation);
        if (freshInput === undefined) return { status: "unavailable", reason: "session_input_unavailable" };
        if (Buffer.byteLength(freshInput, "utf8") > MAX_INPUT_BYTES) return { status: "error", reason: "input_too_large" };
        const result = await runHookCommand({
          command: command.command,
          cwd: sessionConfig.cwd,
          env: { ...shell.childEnvironment, AGENC_PROJECT_DIR: configStore.projectRoot },
          shellPath: shell.path,
          commandWrapperArgv: shell.commandWrapperArgv,
          stdin: freshInput,
          timeoutMs: TIMEOUT_MS,
          signal: effectSignal,
          sandboxExecutionBroker: broker,
          beforeSpawn: () => {
            admission.markDispatched(reservationId, {
              boundary: "tool_effect",
              details: { hookEvent: "StatusLine" },
            });
            dispatched = true;
          },
        });
        if (!dispatched) {
          admission.void(reservationId, "status_line_stopped_before_dispatch");
        } else if (result.processStarted !== false && (effectSignal.aborted || result.status === "timeout" || result.status === "skipped")) {
          admission.holdUnknown(reservationId, "status_line_cancelled_after_dispatch");
        } else {
          admission.reconcile(reservationId, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
        }
        settled = true;
        if (effectSignal.aborted) return { status: "unavailable", reason: "cancelled" };
        if (result.status !== "success") return { status: "error", reason: "command_failed" };
        if (result.error !== undefined || Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) {
          return { status: "error", reason: "output_too_large" };
        }
        const text = result.stdout.trim().split("\n").flatMap((line) => line.trim() || []).join("\n");
        return { status: "rendered", text };
      } finally {
        if (!settled) {
          if (dispatched) admission.holdUnknown(reservationId, "status_line_failed_after_dispatch");
          else admission.void(reservationId, "status_line_stopped_before_dispatch");
        }
      }
    });
  } finally {
    await lifetime.release();
    await lifetime.settled();
    if (completedReservationId !== undefined) admission.acknowledgeCompletion(completedReservationId);
  }
}

export function executeSessionStatusLine(
  session: Session,
  presentation: SessionStatusLinePresentation = {},
  signal?: AbortSignal,
): Promise<SessionStatusLineResult> {
  if (activeSessions.has(session)) return Promise.resolve({ status: "unavailable", reason: "busy" });
  activeSessions.add(session);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  timer.unref?.();
  const signals = [timeout.signal, session.abortController.signal];
  const shutdownSignal = session.services.mcpStartupCancellationToken.signal;
  if (shutdownSignal !== undefined) signals.push(shutdownSignal);
  if (signal !== undefined) signals.push(signal);
  const combined = AbortSignal.any(signals);
  const operation = Promise.resolve().then(() => runSessionStatusLine(session, presentation, combined))
    .then((result): SessionStatusLineResult => timeout.signal.aborted ? { status: "error", reason: "timeout" } : result)
    .catch((error: unknown): SessionStatusLineResult => {
      if (timeout.signal.aborted) return { status: "error", reason: "timeout" };
      if (combined.aborted) return { status: "unavailable", reason: "cancelled" };
      if (error instanceof AdmissionDeniedError) return { status: "blocked", reason: "admission_denied" };
      if (error instanceof WorkspaceMutationCoordinatorError) return { status: "blocked", reason: "editor_workspace_owned" };
      if (error instanceof SandboxExecutionError) return { status: "blocked", reason: error.code };
      return { status: "error", reason: "execution_failed" };
    }).finally(() => {
      clearTimeout(timer);
      activeSessions.delete(session);
    });
  return session.trackDurableOperation(operation);
}
