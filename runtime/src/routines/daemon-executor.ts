import { randomUUID } from "node:crypto";
import type { AgenCDaemonAgentManager } from "../app-server/agent-lifecycle.js";
import { canonicalSessionEnvironmentKeys } from "../session/environment.js";
import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { RoutineExecutionUnsettledError, type RoutineExecutor } from "./service.js";

/** The routine configuration owns provider and model; the daemon env never overrides them. */
const ROUTINE_ENV_EXCLUDED = new Set(["AGENC_PROVIDER", "AGENC_MODEL"]);

/**
 * Client-owned session environment for a routine agent, taken from the daemon's
 * own process environment. A daemon-created agent inherits nothing on its own
 * (the daemon materializes exactly `envOverrides`), so without this snapshot a
 * routine on any keyed provider dies at agent creation with
 * "<provider> provider requires credentials" even when the daemon holds the key.
 */
export function routineSessionEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const key of canonicalSessionEnvironmentKeys(env)) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0 && !ROUTINE_ENV_EXCLUDED.has(key)) overrides[key] = value;
  }
  return Object.freeze(overrides);
}

/** Fresh canonical Core agent/session per invocation; permission decisions stay in Core. */
export function createDaemonRoutineExecutor(options: {
  agentManager: Pick<AgenCDaemonAgentManager, "createAgent" | "streamAgentMessage" | "cancelRunTree" | "stopAgent" | "finishRoutineRun">;
  runtimeOptions: AgentRuntimeOptions;
  /** Daemon process environment, frozen at construction; only canonical client keys are forwarded. */
  environment?: Readonly<Record<string, string | undefined>>;
}): RoutineExecutor {
  const authority = Object.freeze({
    ...options.runtimeOptions,
    dangerouslyBypassApprovalsAndSandbox: false,
    allowUntrustedHooks: false,
    stdinDataMode: false,
    remoteMode: false,
  });
  const envOverrides = routineSessionEnvironment(options.environment ?? {});
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
      const stop = async (): Promise<void> => {
        if (agentId === undefined || finalized) return;
        try { await options.agentManager.stopAgent({ agentId, reason: "Routine invocation finished" }); finalized = true; }
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
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const agent = await options.agentManager.createAgent({
          objective: routine.name, cwd: routine.cwd, deferInitialTurn: true,
          ...(routine.provider ? { provider: routine.provider } : {}),
          ...(routine.model ? { model: routine.model } : {}),
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
          permissionMode: routine.permissionMode, runtimeOptions: authority,
          metadata: { routineId: routine.id, routineRunId: run.id },
        });
        agentId = agent.agentId;
        if (!agent.sessionId) throw new Error("Core did not create a routine session.");
        context.bind({ agentId, sessionId: agent.sessionId, coreRunId: agentId });
        if (context.signal.aborted) { cancel(); await cancellation; return "cancelled"; }
        const messageId = `routine_message_${randomUUID()}`;
        const result = await Promise.race([options.agentManager.streamAgentMessage({
          sessionId: agent.sessionId, content: routine.instructions,
          messageId, streamId: `routine_stream_${randomUUID()}`,
          acceptedAt: new Date().toISOString(), ifBusy: "reject", methodName: "message.stream",
        }), cancellationOutcome]);
        if (context.signal.aborted) { cancel(); await cancellation; return "cancelled"; }
        const outcome = await options.agentManager.finishRoutineRun(agentId, messageId);
        finalized = true;
        return outcome ?? (result.terminal?.code === 0 ? "completed" : result.terminal?.code === 130 ? "cancelled" : "failed");
      } finally {
        context.signal.removeEventListener("abort", cancel);
        if (agentId !== undefined) {
          if (context.signal.aborted) { cancel(); await cancellation; }
          else await stop();
        }
      }
    },
  };
}
