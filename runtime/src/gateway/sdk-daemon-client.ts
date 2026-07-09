/**
 * Production {@link GatewayDaemonClient} backed by `@tetsuo-ai/agenc-sdk`
 * (TODO task 6).
 *
 * This is the ONLY place the gateway touches the daemon, and it goes through
 * the public embedding SDK — never runtime session internals. Kept dependency-
 * light and adapter-shaped so the gateway core stays unit-testable against a
 * fake client.
 *
 * The SDK import is dynamic so the gateway core module graph does not hard-
 * depend on the SDK build being present (tests use the fake client).
 */

import type {
  GatewayDaemonClient,
  GatewayPermissionDecision,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
} from "./types.js";

export interface SdkDaemonClientOptions {
  /** Absolute path to the agenc CLI for daemon autostart when embedding. */
  readonly agencCommand?: string;
  readonly socketPath?: string;
  readonly cookiePath?: string;
  readonly autostart?: boolean;
}

// Minimal structural shapes for the slice of the SDK we use — avoids a
// compile-time type dependency while staying honest about the surface.
interface SdkPermissionRequest {
  readonly requestId: string;
  readonly toolName?: string;
  readonly permissions: readonly string[];
  readonly reason?: string;
}
interface SdkPromptRun extends AsyncIterable<{ type: string; delta?: string; message?: string }> {
  result(): Promise<{ stopReason: string; finalMessage: string }>;
}
interface SdkSession {
  readonly sessionId: string;
  prompt(text: string, options?: {
    onPermissionRequest?: (
      request: SdkPermissionRequest,
    ) => Promise<GatewayPermissionDecision>;
  }): SdkPromptRun;
}
interface SdkClient {
  createSession(): Promise<SdkSession>;
  attachSession(sessionId: string): Promise<SdkSession>;
  close(): Promise<void>;
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
      return { stopReason, finalMessage: result.finalMessage };
    },
  };
}

export async function createSdkDaemonClient(
  options: SdkDaemonClientOptions = {},
): Promise<GatewayDaemonClient> {
  // Dynamic import keeps the SDK optional for the core module graph.
  const sdk = (await import("@tetsuo-ai/agenc-sdk")) as unknown as {
    connect(opts: SdkDaemonClientOptions): Promise<SdkClient>;
  };
  const client = await sdk.connect(options);
  return {
    async createSession() {
      return wrapSession(await client.createSession());
    },
    async attachSession(sessionId: string) {
      return wrapSession(await client.attachSession(sessionId));
    },
    async close() {
      await client.close();
    },
  };
}
