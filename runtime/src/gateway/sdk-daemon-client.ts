/**
 * Production {@link GatewayDaemonClient} backed by `@tetsuo-ai/agenc-sdk`
 * (TODO task 6; agent provisioning TODO task 34).
 *
 * This is the ONLY place the gateway touches the daemon, and it goes through
 * the public embedding SDK — never runtime session internals. Kept dependency-
 * light and adapter-shaped so the gateway core stays unit-testable against a
 * fake client.
 *
 * The SDK import is dynamic so the gateway core module graph does not hard-
 * depend on the SDK build being present (tests use the fake client).
 *
 * ## Why createSession() spawns a background agent (task 34)
 *
 * A bare daemon `session.create` binds the session to `agent_default`, an
 * agent nothing in a headless gateway run ever provisions — the first
 * `message.send` then throws `AgenC daemon agent not found: agent_default`.
 * The daemon's only live-turn substrate is a background agent
 * (`agent.create` → full runtime bootstrap → `message.send` routes into its
 * run loop), and each background agent supports exactly ONE live session:
 * the one `agent.create` itself creates (the runner keeps a single
 * session-event binding stamped with that session's id).
 *
 * So `createSession()` here spawns a PASSIVE agent — `initialContent: []`
 * suppresses the turn-1 objective submit (pinned by a runner contract test)
 * — and adopts the agent's own session. One gateway conversation = one
 * daemon agent = one session: history isolation between channel peers and
 * the heartbeat falls out of the 1:1:1 shape.
 */

import type {
  GatewayDaemonClient,
  GatewayPermissionDecision,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
  GatewaySessionCreateOptions,
} from "./types.js";

export interface SdkDaemonClientOptions {
  /** Absolute path to the agenc CLI for daemon autostart when embedding. */
  readonly agencCommand?: string;
  readonly socketPath?: string;
  readonly cookiePath?: string;
  readonly autostart?: boolean;
  /** Working directory for gateway daemon agents (default: daemon's choice). */
  readonly cwd?: string;
  /** Test seam: inject the SDK module instead of importing it. */
  readonly sdk?: SdkModule;
}

// Minimal structural shapes for the slice of the SDK we use — avoids a
// compile-time type dependency while staying honest about the surface.
interface SdkPermissionRequest {
  readonly requestId: string;
  readonly toolName?: string;
  readonly permissions: readonly string[];
  readonly reason?: string;
}
interface SdkUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
interface SdkPromptRun extends AsyncIterable<{ type: string; delta?: string; message?: string }> {
  result(): Promise<{
    stopReason: string;
    finalMessage: string;
    usage?: SdkUsage;
  }>;
}
interface SdkSession {
  readonly sessionId: string;
  prompt(text: string, options?: {
    onPermissionRequest?: (
      request: SdkPermissionRequest,
    ) => Promise<GatewayPermissionDecision>;
  }): SdkPromptRun;
}
interface SdkAgentCreateResult {
  readonly agentId: string;
  readonly sessionId?: string;
}
interface SdkClient {
  spawnAgent(params: {
    readonly objective: string;
    readonly initialContent: readonly never[];
    readonly cwd?: string;
    readonly metadata?: Record<string, string>;
  }): Promise<SdkAgentCreateResult>;
  resumeSession(sessionId: string): Promise<SdkSession>;
  close(): Promise<void>;
}
export interface SdkModule {
  connect(opts: {
    readonly agencCommand?: string;
    readonly socketPath?: string;
    readonly cookiePath?: string;
    readonly autostart?: boolean;
  }): Promise<SdkClient>;
}

/**
 * True when a daemon error means the session's backing agent is gone or
 * unusable (daemon restarted, agent stopped/reaped, session pruned) — the
 * caller should discard the session and provision a fresh one. Matches the
 * daemon's lifecycle error codes carried in JSON-RPC `error.data.code`, with
 * a message fallback for transports that flatten the data object.
 */
export function isDaemonAgentGoneError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (data !== null && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (
      code === "AGENT_NOT_FOUND" ||
      code === "BACKGROUND_RUNNER_UNAVAILABLE" ||
      code === "SESSION_NOT_FOUND" ||
      code === "SESSION_CLOSED"
    ) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return /agent not (?:found|running)|recovered without a live runtime|session not found or closed|session not found|session is closed/i.test(
    message,
  );
}

function wrapSession(sdkSession: SdkSession): GatewaySession {
  return {
    sessionId: sdkSession.sessionId,
    async prompt(
      text: string,
      handlers: GatewayPromptHandlers,
    ): Promise<GatewayPromptResult> {
      const run = sdkSession.prompt(text, {
        onPermissionRequest: (request) =>
          handlers.onPermissionRequest({
            requestId: request.requestId,
            ...(request.toolName !== undefined
              ? { toolName: request.toolName }
              : {}),
            permissions: request.permissions,
            ...(request.reason !== undefined ? { reason: request.reason } : {}),
          }),
      });
      for await (const event of run) {
        if (event.type === "text" && typeof event.delta === "string") {
          await handlers.onEvent({ type: "text", delta: event.delta });
        } else if (event.type === "status") {
          await handlers.onEvent({
            type: "status",
            ...(typeof event.message === "string"
              ? { message: event.message }
              : {}),
          });
        }
      }
      const result = await run.result();
      const stopReason =
        result.stopReason === "completed" ||
        result.stopReason === "errored" ||
        result.stopReason === "stopped"
          ? result.stopReason
          : "errored";
      const usage =
        result.usage !== undefined
          ? {
              inputTokens: result.usage.inputTokens ?? 0,
              outputTokens: result.usage.outputTokens ?? 0,
            }
          : undefined;
      return {
        stopReason,
        finalMessage: result.finalMessage,
        ...(usage !== undefined ? { usage: usage } : {}),
      };
    },
  };
}

export async function createSdkDaemonClient(
  options: SdkDaemonClientOptions = {},
): Promise<GatewayDaemonClient> {
  // Dynamic import keeps the SDK optional for the core module graph.
  const sdk =
    options.sdk ??
    ((await import("@tetsuo-ai/agenc-sdk")) as unknown as SdkModule);
  const client = await sdk.connect({
    ...(options.agencCommand !== undefined
      ? { agencCommand: options.agencCommand }
      : {}),
    ...(options.socketPath !== undefined
      ? { socketPath: options.socketPath }
      : {}),
    ...(options.cookiePath !== undefined
      ? { cookiePath: options.cookiePath }
      : {}),
    ...(options.autostart !== undefined ? { autostart: options.autostart } : {}),
  });
  return {
    async createSession(createOptions?: GatewaySessionCreateOptions) {
      const label = createOptions?.label;
      // Passive agent: empty initialContent suppresses the turn-1 objective
      // submit, so provisioning costs zero LLM calls. The objective string is
      // operator-facing metadata (agent.list) only.
      const created = await client.spawnAgent({
        objective:
          label !== undefined ? `gateway: ${label}` : "gateway session",
        initialContent: [],
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        metadata: {
          source: "agenc-gateway",
          ...(label !== undefined ? { gatewayLabel: label } : {}),
        },
      });
      if (created.sessionId === undefined) {
        throw new Error(
          `gateway: daemon agent ${created.agentId} was created without a session — cannot run turns`,
        );
      }
      return wrapSession(await client.resumeSession(created.sessionId));
    },
    async attachSession(sessionId: string) {
      return wrapSession(await client.resumeSession(sessionId));
    },
    async close() {
      await client.close();
    },
  };
}
