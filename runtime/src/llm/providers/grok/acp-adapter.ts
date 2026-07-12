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
import { LLMProviderError } from "../../errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderExecutionProfile,
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
  /** Workspace the CLI session is anchored to (default: process.cwd()). */
  cwd?: string;
  /** Grok CLI binary override (default: `grok`, or AGENC_GROK_CLI). */
  binaryPath?: string;
  timeoutMs?: number;
  contextWindowTokens?: number;
  env?: NodeJS.ProcessEnv;
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
  private ready: Promise<void> | null = null;

  constructor(config: GrokAcpProviderConfig) {
    this.config = config;
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

  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.ready = null;
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
    if (this.ready !== null && this.client !== null && !this.client.isClosed) {
      return this.ready.then(() => this.client as XaiAcpClient);
    }
    const env = this.env();
    const client = new XaiAcpClient({
      ...(this.resolveBinary() !== undefined
        ? { command: this.resolveBinary() }
        : {}),
      cwd: this.config.cwd ?? process.cwd(),
      env,
      clientInfo: { name: "agenc", version: "0" },
      onPermissionRequest: resolvePermissionHandler(env),
      ...(this.config.timeoutMs !== undefined
        ? { requestTimeoutMs: this.config.timeoutMs }
        : {}),
    });
    this.client = client;
    this.ready = (async () => {
      await client.initialize();
      await client.authenticate(resolveAuthMethodId(env));
    })().catch(error => {
      client.dispose();
      this.client = null;
      this.ready = null;
      throw error;
    });
    return this.ready.then(() => client);
  }

  private resolveBinary(): string | undefined {
    return (
      this.config.binaryPath?.trim() ||
      this.env().AGENC_GROK_CLI?.trim() ||
      undefined
    );
  }

  private mapError(error: unknown): Error {
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
