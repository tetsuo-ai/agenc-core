/**
 * Grok composer provider — ACP-backed.
 *
 * Per xAI, `grok-composer-*` models are served ONLY through the Agent
 * Client Protocol by the Grok Build CLI (`grok agent stdio`), never by
 * direct calls to the inference endpoints. This adapter implements the
 * LLMProvider chat surface on top of that: one spawned CLI per provider
 * instance, a fresh ACP session per chat call (agenc resends full history
 * each turn), streamed `agent_message_chunk` text as the reply.
 *
 * Boundaries:
 *  - No agenc tool calls: composer runs inside the Grok CLI's own loop.
 *    The catalog marks composer models `supportsToolUse: false`.
 *  - Workspace authority stays with agenc: client fs/terminal capabilities
 *    are declined and agent permission requests are rejected by default
 *    (AGENC_GROK_ACP_PERMISSIONS=allow opts into the CLI's own tooling).
 *  - Auth belongs to the Grok CLI (its cached OAuth login or XAI_API_KEY);
 *    the spawn env carries GROK_OAUTH2_REFERRER=agenc for attribution.
 */

import { resolve } from "node:path";

import {
  allowPermissionDecision,
  GROK_ACP_AUTH_METHOD_API_KEY,
  GROK_ACP_AUTH_METHOD_CACHED_TOKEN,
  rejectPermissionDecision,
  XaiAcpClient,
  XaiAcpError,
  type XaiAcpPermissionDecision,
  type XaiAcpPermissionRequest,
} from "../../../services/xai/acp.js";
import {
  SandboxExecutionError,
  type SandboxExecutionBrokerLike,
} from "../../../sandbox/execution-broker.js";
import {
  registerSandboxExecutionLifecycleParticipant,
} from "../../../sandbox/execution-lifecycle.js";
import { LLMProviderError } from "../../errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMProviderSessionForkOptions,
  LLMResponse,
  StreamProgressCallback,
} from "../../types.js";

export const GROK_COMPOSER_MODEL_PREFIX = "grok-composer";

export function isGrokComposerModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase().startsWith(GROK_COMPOSER_MODEL_PREFIX) ??
    false;
}

export interface GrokAcpProviderConfig {
  model: string;
  /** @deprecated The authenticated sandbox broker is the cwd authority. */
  cwd?: string;
  /** Grok CLI binary override (default: `grok`, or AGENC_GROK_CLI). */
  binaryPath?: string;
  timeoutMs?: number;
  contextWindowTokens?: number;
  env?: NodeJS.ProcessEnv;
  /** Authenticated session boundary for the ACP child process. */
  sandboxExecutionBroker?: SandboxExecutionBrokerLike;
}

function resolvePermissionHandler(
  env: NodeJS.ProcessEnv,
): (request: XaiAcpPermissionRequest) => XaiAcpPermissionDecision {
  const mode = env.AGENC_GROK_ACP_PERMISSIONS?.trim().toLowerCase();
  return mode === "allow" ? allowPermissionDecision : rejectPermissionDecision;
}

function resolveAuthMethodId(env: NodeJS.ProcessEnv): string {
  return env.XAI_API_KEY?.trim()
    ? GROK_ACP_AUTH_METHOD_API_KEY
    : GROK_ACP_AUTH_METHOD_CACHED_TOKEN;
}

/**
 * Flatten the conversation to a single text prompt. Composer sessions are
 * created fresh per call, so the transcript travels in the prompt body;
 * non-text parts are represented by bracketed placeholders.
 */
export function flattenMessagesForAcp(
  messages: readonly LLMMessage[],
  systemPrompt?: string,
): string {
  const sections: string[] = [];
  if (systemPrompt?.trim()) {
    sections.push(systemPrompt.trim());
  }
  for (const message of messages) {
    const text = flattenContent(message.content);
    if (!text.trim()) continue;
    if (message.role === "system") {
      sections.push(text);
      continue;
    }
    const label = message.role === "assistant" ? "Assistant" : "User";
    sections.push(`${label}: ${text}`);
  }
  return sections.join("\n\n");
}

function flattenContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else {
      parts.push(`[${part.type}]`);
    }
  }
  return parts.join("\n");
}

export class GrokAcpProvider implements LLMProvider {
  readonly name = "grok";

  private readonly config: GrokAcpProviderConfig;
  private client: XaiAcpClient | null = null;
  private ready: Promise<XaiAcpClient> | null = null;
  private suspended = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private clientClose: Promise<void> | null = null;
  private unregisterLifecycle: (() => void) | null = null;

  constructor(config: GrokAcpProviderConfig) {
    this.config = config;
    const broker = config.sandboxExecutionBroker;
    if (broker !== undefined) {
      this.unregisterLifecycle = registerSandboxExecutionLifecycleParticipant(
        broker,
        {
          name: "grok-acp-provider",
          quiesce: async () => {
            this.suspended = true;
            await this.closeClient();
          },
          resume: async () => {
            if (!this.disposed) this.suspended = false;
          },
        },
      );
    }
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    return this.run(messages, options);
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const response = await this.run(messages, options, chunk => {
      onChunk({ content: chunk, done: false });
    });
    onChunk({ content: "", done: true });
    return response;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile(): Promise<LLMProviderExecutionProfile> {
    return {
      provider: "grok",
      model: this.config.model,
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.config.contextWindowTokens }
        : {}),
    };
  }

  forkForSession(options: LLMProviderSessionForkOptions): GrokAcpProvider {
    if (
      resolve(options.cwd) !== resolve(options.sandboxExecutionBroker.cwd)
    ) {
      throw new LLMProviderError(
        this.name,
        "child provider cwd does not match its sandbox authority",
      );
    }
    return new GrokAcpProvider({
      ...this.config,
      // The broker is authoritative; keeping this field aligned avoids stale
      // diagnostics in callers that still inspect the deprecated option.
      cwd: options.sandboxExecutionBroker.cwd,
      sandboxExecutionBroker: options.sandboxExecutionBroker,
    });
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposed = true;
    this.suspended = true;
    this.unregisterLifecycle?.();
    this.unregisterLifecycle = null;
    const closing = this.closeClient();
    let tracked: Promise<void>;
    tracked = closing.catch((error) => {
      // A failed cleanup retains its exact client and must remain retryable.
      if (this.disposal === tracked) this.disposal = null;
      throw error;
    });
    this.disposal = tracked;
    return tracked;
  }

  private env(): NodeJS.ProcessEnv {
    return this.config.env ?? process.env;
  }

  private async run(
    messages: LLMMessage[],
    options?: LLMChatOptions,
    onTextChunk?: (text: string) => void,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    try {
      const client = await this.ensureReady();
      const session = await client.newSession();
      const wantsSwitch =
        model !== session.currentModelId &&
        (session.availableModels.length === 0 ||
          session.availableModels.some(entry => entry.modelId === model));
      if (wantsSwitch) {
        await client.setSessionModel(session.sessionId, model);
      }
      const prompt = flattenMessagesForAcp(messages, options?.systemPrompt);
      const result = await client.prompt({
        sessionId: session.sessionId,
        text: prompt,
        ...(onTextChunk !== undefined ? { onTextChunk } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (result.stopReason === "cancelled") {
        throw new LLMProviderError(this.name, "composer prompt cancelled");
      }
      return {
        content: result.text,
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model,
        finishReason: result.stopReason === "max_tokens" ? "length" : "stop",
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private ensureReady(): Promise<XaiAcpClient> {
    if (this.disposed) {
      return Promise.reject(
        new LLMProviderError(this.name, "composer provider is disposed"),
      );
    }
    if (this.suspended) {
      return Promise.reject(
        new LLMProviderError(
          this.name,
          "composer provider is quiesced for a workspace transition",
        ),
      );
    }
    const existingReady = this.ready;
    if (existingReady !== null) {
      return existingReady.then((client) => {
        if (!client.isClosed) return client;
        if (this.ready === existingReady) this.ready = null;
        return this.ensureReady();
      });
    }

    const ready = this.startClient();
    this.ready = ready;
    void ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  private async startClient(): Promise<XaiAcpClient> {
    if (this.client !== null) await this.closeClient();
    if (this.disposed || this.suspended) {
      throw new LLMProviderError(
        this.name,
        this.disposed
          ? "composer provider is disposed"
          : "composer provider is quiesced for a workspace transition",
      );
    }
    const env = this.env();
    const broker = this.config.sandboxExecutionBroker;
    const client = new XaiAcpClient({
      ...(this.resolveBinary() !== undefined
        ? { command: this.resolveBinary() }
        : {}),
      // Never inherit ambient process.cwd(): this broker is the authenticated
      // authority and is updated atomically by workspace transitions.
      cwd: broker?.cwd ?? "",
      env,
      ...(broker !== undefined
        ? { sandboxExecutionBroker: broker }
        : {}),
      clientInfo: { name: "agenc", version: "0" },
      onPermissionRequest: resolvePermissionHandler(env),
      ...(this.config.timeoutMs !== undefined
        ? { requestTimeoutMs: this.config.timeoutMs }
        : {}),
    });
    this.client = client;
    let startupError: unknown;
    try {
      await client.initialize();
      await client.authenticate(resolveAuthMethodId(env));
      if (this.disposed || this.suspended || this.client !== client) {
        throw new LLMProviderError(
          this.name,
          this.disposed
            ? "composer provider is disposed"
            : "composer provider is quiesced for a workspace transition",
        );
      }
      return client;
    } catch (error) {
      startupError = error;
    }
    try {
      await client.dispose();
      if (this.client === client) this.client = null;
    } catch (cleanupError) {
      // Do not drop the process owner when startup cleanup fails.
      if (this.client === null) this.client = client;
      throw new AggregateError(
        [startupError, cleanupError],
        "ACP client startup failed and cleanup failed",
      );
    }
    throw startupError;
  }

  private closeClient(): Promise<void> {
    this.ready = null;
    if (this.clientClose !== null) return this.clientClose;
    let tracked: Promise<void>;
    tracked = this.drainClients().then(
      () => {
        if (this.clientClose === tracked) this.clientClose = null;
      },
      (error) => {
        if (this.clientClose === tracked) this.clientClose = null;
        throw error;
      },
    );
    this.clientClose = tracked;
    return tracked;
  }

  private async drainClients(): Promise<void> {
    for (;;) {
      const client = this.client;
      if (client === null) return;
      try {
        await client.dispose();
      } catch (error) {
        // The exact owner stays published until its process tree is confirmed
        // stopped; callers can retry after this single-flight rejects.
        if (this.client === null) this.client = client;
        throw error;
      }
      if (this.client === client) this.client = null;
    }
  }

  private resolveBinary(): string | undefined {
    return (
      this.config.binaryPath?.trim() ||
      this.env().AGENC_GROK_CLI?.trim() ||
      undefined
    );
  }

  private mapError(error: unknown): Error {
    if (error instanceof SandboxExecutionError) return error;
    if (error instanceof LLMProviderError) return error;
    if (error instanceof XaiAcpError) {
      const hint =
        error.code === 'spawn_failed'
          ? ' Composer models need the Grok Build CLI on PATH with a completed `grok` login.'
          : error.code === 'agent_error'
          ? ' Check `grok` login state (cached_token auth) or XAI_API_KEY.'
          : '';
      return new LLMProviderError(this.name, `${error.message}${hint}`);
    }
    return new LLMProviderError(
      this.name,
      error instanceof Error ? error.message : String(error),
    );
  }
}
