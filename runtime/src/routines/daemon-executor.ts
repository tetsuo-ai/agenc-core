import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { AgenCDaemonAgentManager } from "../app-server/agent-lifecycle.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import type { RoutineDesktopTools } from "./types.js";
import { RoutineExecutionUnsettledError, type RoutineExecutor } from "./service.js";

/** Tool execution needs the user's PATH, exactly as every desktop-created session gets it. */
const ROUTINE_ENV_ALWAYS: readonly string[] = ["PATH"];

/** Variables the selected provider itself reads: its credential fields and base-URL override. */
export function providerEnvironmentKeys(provider: string | undefined): readonly string[] {
  const info = resolveBuiltInProviderInfo(provider);
  if (info === undefined) return [];
  const keys = [...info.baseURLEnvVars];
  const credentials = info.credentials;
  if (credentials.kind === "api-key") keys.push(...credentials.apiKey.envVars);
  else if (credentials.kind === "aws-sigv4") {
    keys.push(...credentials.accessKeyId.envVars, ...credentials.secretAccessKey.envVars, ...credentials.sessionToken.envVars, ...credentials.regionEnvVars);
  }
  return keys;
}

/**
 * Session environment for one routine agent: PATH plus the selected provider's
 * own variables, read from the daemon process. A daemon-created agent inherits
 * nothing by itself (the daemon materializes exactly `envOverrides`), so without
 * this a routine on any keyed provider dies at agent creation with "<provider>
 * provider requires credentials" even when the daemon holds the key. Nothing
 * else crosses: no MCP bearers, no session or remote tokens, no browser flags,
 * no other provider's key. The routine configuration decides the provider.
 */
export function routineSessionEnvironment(env: Readonly<Record<string, string | undefined>>, provider: string | undefined): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const key of [...ROUTINE_ENV_ALWAYS, ...providerEnvironmentKeys(provider)]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) overrides[key] = value;
  }
  return Object.freeze(overrides);
}

/** Folder inside a routine's workspace that holds each run's scratch folder. */
export const ROUTINE_SCRATCH_FOLDER = ".agenc-routine";

function isRealDirectory(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}

function insideWorkspace(path: string, workspace: string): boolean {
  const rel = relative(workspace, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The run's scratch folder, `<workspace>/.agenc-routine/<runId>`: its shell
 * commands get it as TMPDIR, because a routine's shell may write only inside
 * its workspace. The parent holds a `.gitignore` of `*`, so git never sees
 * it. Undefined when the parent is not a plain folder in the workspace (a
 * link, a file): Core never creates anything through a link, and the run then
 * keeps temporary files in the workspace itself.
 */
export function prepareRoutineScratch(workspace: string, runId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId)) return undefined;
  try {
    const root = realpathSync(workspace);
    const parent = join(root, ROUTINE_SCRATCH_FOLDER);
    try { mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined; }
    if (!isRealDirectory(parent) || !insideWorkspace(realpathSync(parent), root)) return undefined;
    try { writeFileSync(join(parent, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined; }
    const scratch = join(parent, runId);
    mkdirSync(scratch, { mode: 0o700 });
    return isRealDirectory(scratch) ? scratch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove a finished run's scratch folder. The run could write inside its
 * workspace, so the folder may now be a link: only the link itself is removed
 * then, and nothing is removed through a parent that is not a plain folder.
 */
export function removeRoutineScratch(scratch: string | undefined): void {
  if (scratch === undefined) return;
  try {
    const parent = join(scratch, "..");
    if (!isRealDirectory(parent)) return;
    const stat = lstatSync(scratch);
    if (stat.isSymbolicLink() || !stat.isDirectory()) { unlinkSync(scratch); return; }
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover scratch folder is inside the workspace and ignored by git.
  }
}

/**
 * Fresh canonical Core agent/session per invocation; permission decisions stay in Core.
 *
 * The run starts in the routine's stored permission mode, which is the mode
 * of the session that created it (routines/permission-authority.ts). It never
 * gets the dangerous combined flag: a Bypass routine skips approvals but keeps
 * the OS sandbox, and the daemon runner confines its file writes to the
 * routine's workspace and refuses anything that would need an approver
 * (background-agent-runner.ts, runtime-settings.ts). Its shell commands get a
 * scratch folder inside the workspace as TMPDIR, removed when the run ends.
 */
export function createDaemonRoutineExecutor(options: {
  agentManager: Pick<AgenCDaemonAgentManager, "createAgent" | "streamAgentMessage" | "cancelRunTree" | "stopAgent" | "finishRoutineRun">;
  runtimeOptions: AgentRuntimeOptions;
  /** Daemon process environment, snapshotted at construction; only PATH and the provider's own keys are forwarded. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Provider a routine without an explicit one runs on (the daemon's configured default). */
  defaultProvider?: () => string | undefined;
  prepareSession?: (input: { sessionId: string; routineId: string; runId: string; cwd: string }, signal: AbortSignal) => Promise<RoutineDesktopTools>;
}): RoutineExecutor {
  const authority = Object.freeze({
    ...options.runtimeOptions,
    dangerouslyBypassApprovalsAndSandbox: false,
    allowUntrustedHooks: false,
    stdinDataMode: false,
    remoteMode: false,
  });
  const environment: Readonly<Record<string, string | undefined>> = Object.freeze({ ...(options.environment ?? {}) });
  return {
    async execute(routine, run, context) {
      if (context.signal.aborted) return "cancelled";
      let agentId: string | undefined;
      let cancellation: Promise<unknown> | undefined;
      let finalized = false;
      let resolveCancellation!: (value: { terminal: { code: 130 } }) => void;
      let rejectCancellation!: (error: unknown) => void;
      const cancellationOutcome = new Promise<{ terminal: { code: 130 } }>((resolve, reject) => { resolveCancellation = resolve; rejectCancellation = reject; });
      void cancellationOutcome.catch(() => {});
      const terminal = context.terminal ?? new Promise<never>(() => {});
      const stop = async (): Promise<"completed" | "failed" | "cancelled" | undefined> => {
        if (agentId === undefined || finalized) return;
        try {
          const outcome = await Promise.race([options.agentManager.stopAgent({ agentId, reason: "Routine invocation finished" }), terminal]);
          finalized = true;
          return typeof outcome === "string" ? outcome : undefined;
        }
        catch { throw new RoutineExecutionUnsettledError("Core could not confirm routine quiescence."); }
      };
      const cancel = (): void => {
        if (agentId !== undefined && cancellation === undefined) {
          cancellation = options.agentManager.cancelRunTree({ runId: agentId, reason: "Routine run cancelled" }).catch(async (error) => { await stop(); throw error; });
          void cancellation.then(() => resolveCancellation({ terminal: { code: 130 } }), rejectCancellation);
          // The same rejection is awaited below; the signal callback must not reject globally.
          void cancellation.catch(() => {});
        }
      };
      const finishCancellation = async (): Promise<"completed" | "failed" | "cancelled"> => {
        cancel();
        const outcome = await Promise.race([cancellation!.then(() => "cancelled" as const), terminal]);
        finalized = true;
        return outcome;
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      const scratch = prepareRoutineScratch(routine.cwd, run.id);
      try {
        const envOverrides = routineSessionEnvironment(environment, routine.provider ?? options.defaultProvider?.());
        const agent = await options.agentManager.createAgent({
          objective: routine.name, cwd: routine.cwd, deferInitialTurn: true,
          ...(routine.provider ? { provider: routine.provider } : {}),
          ...(routine.model ? { model: routine.model } : {}),
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          permissionMode: routine.permissionMode,
          runtimeOptions: scratch === undefined ? authority : Object.freeze({ ...authority, routineScratchRoot: scratch }),
          metadata: { routineId: routine.id, routineRunId: run.id },
        });
        agentId = agent.agentId;
        if (!agent.sessionId) throw new Error("Core did not create a routine session.");
        context.bind({ agentId, sessionId: agent.sessionId, coreRunId: agentId });
        if (context.signal.aborted) return await finishCancellation();
        const desktopTools = options.prepareSession
          ? await options.prepareSession({ sessionId: agent.sessionId, routineId: routine.id, runId: run.id, cwd: routine.cwd }, context.signal)
          : { status: "unavailable", reason: "No Desktop client is connected." } as const;
        context.setDesktopTools?.(desktopTools);
        if (context.signal.aborted) return await finishCancellation();
        const content = desktopTools.status === "attached" ? routine.instructions
          : `Desktop tools (browser, terminal, windows) are unavailable in this run: ${(desktopTools.reason ?? "unknown reason").replace(/[.!?]+$/u, "")}.\n${routine.instructions}`;
        const messageId = `routine_message_${randomUUID()}`;
        const result = await Promise.race([options.agentManager.streamAgentMessage({
          sessionId: agent.sessionId, content,
          messageId, streamId: `routine_stream_${randomUUID()}`,
          acceptedAt: new Date().toISOString(), ifBusy: "reject", methodName: "message.stream",
          // This daemon-owned dispatch is local only after Desktop confirmed
          // the attachment. Keep the routine's permission mode independent.
          localMcpAccess: desktopTools.status === "attached",
        }), cancellationOutcome, terminal]);
        if (typeof result === "string") { finalized = true; return result; }
        if (context.signal.aborted) return await finishCancellation();
        const outcome = await Promise.race([options.agentManager.finishRoutineRun(agentId, messageId), terminal]);
        if (outcome !== undefined) finalized = true;
        return outcome ?? await stop() ?? (result.terminal?.code === 0 ? "completed" : result.terminal?.code === 130 ? "cancelled" : "failed");
      } finally {
        context.signal.removeEventListener("abort", cancel);
        try {
          if (agentId !== undefined && !finalized) {
            if (context.signal.aborted) { cancel(); await Promise.race([cancellation!, terminal]); }
            else await stop();
          }
        } finally {
          removeRoutineScratch(scratch);
        }
      }
    },
  };
}
