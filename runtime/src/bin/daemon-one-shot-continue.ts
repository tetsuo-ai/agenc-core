import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { type OneShotContinueSession } from "./route.js";
import { type AgentRuntimeOptions } from "../session/runtime-options.js";
import { hasSupportedFileIdentity } from "../session/session-store.js";
import { resolveLatestSessionId, resolveResumeSessionId, reproveResumeSessionAfterDaemonReady, type ResolvedResumeSession, type ResumeSessionResolution } from "./resume-session.js";
import { AgenCDaemonResponseError } from "../app-server/agent-cli.js";
import type { AgentCreateParams, AgentSummary, MessageContentBlock } from "../app-server/protocol/index.js";
import { isRecord } from "../utils/record.js";
import { type AgenCDaemonCliDeps, type OneShotOutputFormat, stopDaemonAgentBestEffort, oneShotAbortExitCode, awaitDaemonOneShotRun, oneShotCompactFailedContinuation, type PrintModeGoalSet, setPrintModeGoal, printModeGoalExitCode, oneShotStopReason, type OneShotContinueDaemonClient } from "./daemon-one-shot-cli.js";

function describeUnresolvedOneShotSession(
  resolved: Exclude<ResumeSessionResolution, { readonly kind: "ok" }>,
  continueSession: OneShotContinueSession,
): string {
  switch (resolved.kind) {
    case "none":
      return continueSession.kind === "latest"
        ? "agenc: no previous session found for this project"
        : `agenc: session not found in either legacy or hashed project layout: ${continueSession.sessionId}`;
    case "not_found":
      return `agenc: session not found in either legacy or hashed project layout: ${resolved.input}`;
    case "ambiguous":
      return `agenc: ambiguous session id '${resolved.input}' matches: ${resolved.matches.join(", ")}`;
    case "search_incomplete":
      return `agenc: session search stopped at its ${resolved.reason.replaceAll("_", " ")} safety limit; ${
        continueSession.kind === "latest"
          ? "retry with an exact session id"
          : "narrow the session id and retry"
      }`;
  }
}

interface OneShotContinueResumeOptions {
  readonly deps: AgenCDaemonCliDeps;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeOptions: AgentRuntimeOptions;
  readonly agencHome: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly permissionMode?: AgentCreateParams["permissionMode"];
}

/**
 * Resolve which prior session a headless continue targets, or write the
 * operator-facing reason it cannot and return the exit code.
 */
function resolveOneShotContinueTarget(params: {
  readonly cwd: string;
  readonly agencHome: string;
  readonly continueSession: OneShotContinueSession;
}): { readonly descriptor: ResolvedResumeSession; readonly displayId: string } | { readonly exitCode: number } {
  const resolved =
    params.continueSession.kind === "latest"
      ? resolveLatestSessionId(params.cwd, params.agencHome)
      : resolveResumeSessionId(
          params.cwd,
          params.continueSession.sessionId,
          params.agencHome,
        );
  if (resolved.kind !== "ok") {
    process.stderr.write(
      `${describeUnresolvedOneShotSession(resolved, params.continueSession)}\n`,
    );
    return { exitCode: 1 };
  }
  return {
    descriptor: resolved,
    displayId:
      params.continueSession.kind === "latest"
        ? resolved.sessionId
        : params.continueSession.sessionId,
  };
}

/**
 * Reuse the live daemon agent for a session, or revive the session from its
 * rollout. Mirrors `resumeResolvedTUIEntry`: the descriptor is reproved before
 * the revive and the chosen agent must match the trusted workspace and root
 * topology. `revived` tells the caller whether it owns the agent.
 */
async function acquireOneShotContinueAgent(params: {
  readonly daemonClient: OneShotContinueDaemonClient;
  readonly descriptor: ResolvedResumeSession;
  readonly cwdProof: ResumeCwdProof;
  readonly resume: OneShotContinueResumeOptions;
}): Promise<{ readonly agent: AgentSummary; readonly revived: boolean; readonly descriptor: ResolvedResumeSession }> {
  const { deps, agencHome } = params.resume;
  let descriptor = params.descriptor;
  const live = await deps.findAgentBySessionId(
    params.daemonClient,
    descriptor.sessionId,
  );
  if (live !== null) {
    assertResumeCwdProof(descriptor.cwd, params.cwdProof);
    assertLiveAgentMatchesResumeDescriptor(live, descriptor);
    return { agent: live, revived: false, descriptor };
  }
  descriptor = reproveResumeDescriptor(descriptor, agencHome);
  assertResumeCwdProof(descriptor.cwd, params.cwdProof);
  let agent: AgentSummary;
  let revived = true;
  try {
    agent = await deps.resumePromptAgent({
      sessionId: descriptor.sessionId,
      rolloutPath: descriptor.rolloutPath,
      sourceProof: {
        dev: descriptor.sourceDev,
        ino: descriptor.sourceIno,
        size: descriptor.sourceSize,
        sha256: descriptor.sourceSha256,
        cwdDev: descriptor.cwdDev,
        cwdIno: descriptor.cwdIno,
      },
      cwd: descriptor.cwd,
      env: params.resume.env,
      runtimeOptions: params.resume.runtimeOptions,
      ...(params.resume.model !== undefined ? { model: params.resume.model } : {}),
      ...(params.resume.provider !== undefined
        ? { provider: params.resume.provider }
        : {}),
      ...(params.resume.profile !== undefined
        ? { profile: params.resume.profile }
        : {}),
      ...(params.resume.configPath !== undefined
        ? { configPath: params.resume.configPath }
        : {}),
      ...(params.resume.addDirs !== undefined
        ? { addDirs: [...params.resume.addDirs] }
        : {}),
      ...(params.resume.permissionMode !== undefined
        ? { permissionMode: params.resume.permissionMode }
        : {}),
    });
  } catch (resumeError) {
    if (!isCanonicalSessionAlreadyActiveError(resumeError)) throw resumeError;
    // Another client revived the same session first; use its agent.
    const raced = await deps.findAgentBySessionId(
      params.daemonClient,
      descriptor.sessionId,
    );
    if (raced === null) throw resumeError;
    agent = raced;
    revived = false;
  }
  assertResumeCwdProof(descriptor.cwd, params.cwdProof);
  assertLiveAgentMatchesResumeDescriptor(agent, descriptor);
  return { agent, revived, descriptor };
}

/**
 * Headless `-c` / `--resume <id>`: run the prompt as one more turn of a prior
 * session of this project, then exit with that turn's outcome.
 *
 * Mirrors the TUI resume path's trust discipline (cwd proof, descriptor
 * reproving before and after the daemon is ready, live-agent topology check)
 * and the fresh one-shot path's output contract. A session that is live in
 * another client (TUI, desktop) is reused and left running; a session this run
 * revived from its rollout is stopped again when the turn ends, exactly like a
 * fresh one-shot agent.
 */
export async function runDaemonOneShotContinue(params: OneShotContinueResumeOptions & {
  readonly prompt: string;
  readonly cwd: string;
  readonly continueSession: OneShotContinueSession;
  readonly outputFormat?: OneShotOutputFormat;
  readonly initialContent?: string | readonly MessageContentBlock[];
  readonly goal?: PrintModeGoalSet;
  readonly signal: AbortSignal;
}): Promise<number> {
  if (params.signal.aborted) {
    return oneShotAbortExitCode(params.signal);
  }
  const target = resolveOneShotContinueTarget(params);
  if ("exitCode" in target) return target.exitCode;
  const { displayId } = target;
  const failResume = (error: unknown): number => {
    process.stderr.write(
      `agenc: unable to resume session '${displayId}': ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  };
  let cwdProof: ResumeCwdProof;
  try {
    cwdProof = openResumeCwdProof(target.descriptor.cwd);
  } catch (error) {
    return failResume(error);
  }
  let daemonClient: OneShotContinueDaemonClient | null = null;
  let revivedAgentId: string | null = null;
  let completed = false;
  let cancelled = false;
  try {
    assertResumeCwdProof(target.descriptor.cwd, cwdProof);
    let descriptor = reproveResumeDescriptor(target.descriptor, params.agencHome);
    await params.deps.ensureDaemonReady(params.env)();
    assertResumeCwdProof(descriptor.cwd, cwdProof);
    descriptor = reproveResumeSessionAfterDaemonReady(descriptor, params.agencHome);
    daemonClient = await params.deps.createConnectedTuiClient({ env: params.env });
    const acquired = await acquireOneShotContinueAgent({
      daemonClient,
      descriptor,
      cwdProof,
      resume: params,
    });
    if (acquired.revived) revivedAgentId = acquired.agent.agentId;
    if (params.signal.aborted) {
      cancelled = true;
      return oneShotAbortExitCode(params.signal);
    }
    const attachment = await daemonClient.request(
      "agent.attach",
      {
        agentId: acquired.agent.agentId,
        clientId: `agenc-one-shot-${process.pid}`,
      },
      { signal: params.signal },
    );
    const sessionId = attachment.sessionIds[0] ?? acquired.descriptor.sessionId;
    const client = daemonClient;
    const goal = params.goal;
    if (
      goal !== undefined &&
      !(await setPrintModeGoal(client, sessionId, goal, params.signal))
    ) {
      return 1;
    }
    const content = goal?.kickoff ?? params.initialContent ?? params.prompt;
    const run = await awaitDaemonOneShotRun({
      daemonClient,
      sessionId,
      agentId: acquired.agent.agentId,
      outputFormat: params.outputFormat ?? "text",
      signal: params.signal,
      ...(params.runtimeOptions.deadlineAt !== undefined
        ? { deadlineAt: params.runtimeOptions.deadlineAt }
        : {}),
      startTurn: (streamId) =>
        client.request(
          "message.stream",
          { sessionId, content, clientMessageId: randomUUID(), streamId,
            exactOutput: (params.outputFormat ?? "text") !== "text" },
          { signal: params.signal },
        ),
      ...oneShotCompactFailedContinuation({
        daemonClient: client,
        sessionId,
        env: params.env,
        signal: params.signal,
        exactOutput: (params.outputFormat ?? "text") !== "text",
      }),
    });
    cancelled = run.cancelled;
    completed = !cancelled;
    return goal !== undefined && !cancelled
      ? await printModeGoalExitCode(client, sessionId, run.code, params.signal)
      : run.code;
  } catch (error) {
    if (params.signal.aborted) {
      cancelled = true;
      return oneShotAbortExitCode(params.signal);
    }
    return failResume(error);
  } finally {
    if (daemonClient !== null) {
      // Only the agent this run revived is a one-shot resource; a live agent
      // belongs to the client that started it and keeps running.
      if (revivedAgentId !== null) {
        await stopDaemonAgentBestEffort({
          deps: params.deps,
          daemonClient,
          env: params.env,
          agentId: revivedAgentId,
          reason: oneShotStopReason(cancelled, completed),
        });
      }
      await daemonClient.close().catch(() => {
        /* best effort */
      });
    }
    closeSync(cwdProof.fd);
  }
}

function sameResumeDescriptor(
  left: ResolvedResumeSession,
  right: ResolvedResumeSession,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.rolloutPath === right.rolloutPath &&
    left.cwd === right.cwd &&
    left.sourceDev === right.sourceDev &&
    left.sourceIno === right.sourceIno &&
    left.sourceSize === right.sourceSize &&
    left.sourceSha256 === right.sourceSha256 &&
    left.cwdDev === right.cwdDev &&
    left.cwdIno === right.cwdIno
  );
}

export function reproveResumeDescriptor(
  expected: ResolvedResumeSession,
  agencHome: string,
): ResolvedResumeSession {
  const observed = resolveResumeSessionId(
    expected.cwd,
    expected.sessionId,
    agencHome,
  );
  if (observed.kind !== "ok" || !sameResumeDescriptor(expected, observed)) {
    throw new Error(
      `canonical resume source for ${expected.sessionId} changed during authorization`,
    );
  }
  return observed;
}

export interface ResumeCwdProof {
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

export function openResumeCwdProof(cwd: string): ResumeCwdProof {
  const before = lstatSync(cwd, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !hasSupportedFileIdentity(before) ||
    realpathSync(cwd) !== cwd
  ) {
    throw new Error("canonical resume workspace is unavailable or unsafe");
  }
  const noFollow =
    "O_NOFOLLOW" in fsConstants ? (fsConstants.O_NOFOLLOW as number) : 0;
  const directoryOnly =
    "O_DIRECTORY" in fsConstants ? (fsConstants.O_DIRECTORY as number) : 0;
  const fd = openSync(cwd, fsConstants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isDirectory() ||
      !hasSupportedFileIdentity(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("canonical resume workspace changed while being opened");
    }
    return { fd, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function assertResumeCwdProof(cwd: string, proof: ResumeCwdProof): void {
  const opened = fstatSync(proof.fd, { bigint: true });
  const observed = lstatSync(cwd, { bigint: true });
  if (
    !opened.isDirectory() ||
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    !hasSupportedFileIdentity(opened) ||
    !hasSupportedFileIdentity(observed) ||
    opened.dev !== proof.dev ||
    opened.ino !== proof.ino ||
    observed.dev !== proof.dev ||
    observed.ino !== proof.ino ||
    realpathSync(cwd) !== cwd
  ) {
    throw new Error("canonical resume workspace changed during authorization");
  }
}

export function assertLiveAgentMatchesResumeDescriptor(
  agent: AgentSummary,
  descriptor: ResolvedResumeSession,
): void {
  const metadataPath =
    typeof agent.metadata?.agentPath === "string"
      ? agent.metadata.agentPath
      : undefined;
  const rolloutPath =
    typeof agent.metadata?.canonicalRolloutPath === "string"
      ? agent.metadata.canonicalRolloutPath
      : undefined;
  const rolloutDev =
    typeof agent.metadata?.canonicalRolloutDev === "string"
      ? agent.metadata.canonicalRolloutDev
      : undefined;
  const rolloutIno =
    typeof agent.metadata?.canonicalRolloutIno === "string"
      ? agent.metadata.canonicalRolloutIno
      : undefined;
  if (
    agent.cwd !== descriptor.cwd ||
    (agent.agentPath ?? metadataPath) !== "/root" ||
    rolloutPath !== descriptor.rolloutPath ||
    rolloutDev !== descriptor.sourceDev ||
    rolloutIno !== descriptor.sourceIno
  ) {
    throw new Error(
      `live daemon agent ${agent.agentId} does not match the trusted resume workspace and root topology`,
    );
  }
}

export function isCanonicalSessionAlreadyActiveError(error: unknown): boolean {
  return (
    error instanceof AgenCDaemonResponseError &&
    isRecord(error.data) &&
    error.data.code === "CANONICAL_SESSION_ALREADY_ACTIVE"
  );
}
