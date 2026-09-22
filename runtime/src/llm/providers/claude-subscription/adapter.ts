/** Opt-in Claude CLI transport. AgenC owns the tool loop and permissions. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse, StreamProgressCallback } from "../../types.js";
import { validateAgentInvocationMessageSequence } from "../../../contracts/agent-invocation-envelope.js";

function bridgePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    for (const candidate of [join(dir, "bridge.py"), join(dir, "claude-subscription", "bridge.py")]) {
      if (existsSync(candidate)) return candidate;
    }
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  throw new Error("Claude subscription transport assets are missing; rebuild AgenC");
}
export const PROVIDER = "claude-subscription-experimental";
interface NativeResponse {
  model: string;
  choices: Array<{ finish_reason: LLMResponse["finishReason"]; message: {
    content?: string; reasoning_content?: string; reasoning_details?: unknown[];
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  } }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number }; cache_creation_input_tokens?: number;
    native_admission?: { upstream_requests: number; blocked_requests: number };
  };
}
export interface ClaudeStatus { available: boolean; loggedIn: boolean; subscription: boolean; plan?: string }
// AgenC tools can contain dots and exceed Claude/MCP's wire-name limit.
export const wireName = (name: string): string => "agenc_" + createHash("sha256").update(name).digest("hex").slice(0, 40);

export function prepareRequest(model: string, messages: LLMMessage[], options: LLMChatOptions = {}) {
  validateAgentInvocationMessageSequence(messages);
  for (const key of ["structuredOutput", "serviceTier", "modelVerbosity", "maxTurns"] as const) {
    if (options[key] !== undefined) throw new Error(`Experimental Claude provider does not support ${key}`);
  }
  if (options.skipCacheWrite) throw new Error("Claude subscription does not support skipCacheWrite");
  if (options.toolChoice && options.toolChoice !== "auto" && options.toolChoice !== "none") throw new Error(`Unsupported Claude toolChoice: ${JSON.stringify(options.toolChoice)}`);
  const history = messages.map((message) => {
    const origin = message.providerReasoningProvenance;
    const replay = message.role === "assistant" && origin?.provider === PROVIDER && origin.model === model && message.providerReasoningContent;
    return {
      role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(part => {
        // Attachment filenames and extraction fallbacks belong to AgenC, not the native API schema.
        if (part.type === "document") return { type: part.type, source: part.source, ...(part.title ? { title: part.title } : {}) };
        return part;
      }),
      ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: wireName(call.name), arguments: call.arguments } })) } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(replay ? { reasoning_details: JSON.parse(replay) } : {}),
    };
  });
  if (options.systemPrompt) history.unshift({ role: "system", content: options.systemPrompt });
  const toolNames = new Map<string, string>();
  const allowed = options.toolRouting?.allowedToolNames;
  const tools = (options.toolChoice === "none" ? [] : options.tools ?? []).filter(tool => allowed === undefined || allowed.includes(tool.function.name)).map((tool) => {
    const name = wireName(tool.function.name);
    if (toolNames.has(name)) throw new Error("Duplicate tool name");
    toolNames.set(name, tool.function.name);
    return { ...tool, function: { ...tool.function, name, description: `AgenC tool: ${tool.function.name}\n${tool.function.description ?? ""}` } };
  });
  return {
    model, messages: history, tools,
    ...(options.parallelToolCalls === false ? { parallel_tool_calls: false } : {}),
    max_tokens: options.maxOutputTokens ?? 1024,
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    ...(options.reasoningEffort ? { extra_body: { reasoning: { effort: options.reasoningEffort } } } : {}),
    timeout: (options.timeoutMs ?? 120_000) / 1000,
  };
}

export function parseResponse(response: NativeResponse, request: ReturnType<typeof prepareRequest>, options: LLMChatOptions = {}): LLMResponse {
  if (response.usage?.native_admission?.upstream_requests !== 1) throw new Error("Expected exactly one upstream request");
  const choice = response.choices?.[0];
  if (!choice || !["stop", "tool_calls", "length", "content_filter"].includes(choice.finish_reason)) throw new Error("Invalid completion");
  const usage = response.usage;
  if (![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every((x) => Number.isSafeInteger(x) && x >= 0)) throw new Error("Missing token usage");
  const advertised = new Set(request.tools.map(tool => tool.function.name));
  const names = new Map((options.tools ?? []).filter(tool => advertised.has(wireName(tool.function.name))).map((tool) => [wireName(tool.function.name), tool.function.name]));
  const ids = new Set<string>();
  const nativeStops = (choice.message.reasoning_details ?? []).flatMap((detail) => {
    const value = detail as { messages?: Array<{ stop_reason?: string }> };
    return (value.messages ?? []).map((message) => message.stop_reason);
  });
  if (choice.message.tool_calls?.length && nativeStops.some((stop) => stop === "max_tokens" || stop === "model_context_window_exceeded" || stop === "refusal")) {
    throw new Error("Native generation stopped before a normal tool completion");
  }
  const toolCalls = (choice.message.tool_calls ?? []).map((call) => {
    if (!names.has(call.function.name) || !call.id || ids.has(call.id)) throw new Error("Unadvertised or duplicate tool call");
    ids.add(call.id);
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
    return { id: call.id, name: names.get(call.function.name)!, arguments: call.function.arguments };
  });
  if ((choice.finish_reason === "tool_calls") !== (toolCalls.length > 0)) throw new Error("Inconsistent tool completion");
  if (options.parallelToolCalls === false && toolCalls.length > 1) throw new Error("Claude returned parallel calls despite serial tool policy");
  return {
    content: choice.message.content ?? "", toolCalls, model: request.model,
    finishReason: nativeStops.includes("refusal") ? "content_filter" : choice.finish_reason,
    usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
      availability: "reported", provenance: "provider", cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens },
    ...(choice.message.reasoning_content ? { thinking: [{ text: choice.message.reasoning_content, redacted: false }] } : {}),
    ...(choice.message.reasoning_details ? { providerReasoningContent: JSON.stringify(choice.message.reasoning_details),
      providerReasoningProvenance: { provider: PROVIDER, model: request.model } } : {}),
  };
}

export class ClaudeSubscriptionProvider implements LLMProvider {
  readonly name = PROVIDER;
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(readonly model = "sonnet", private readonly python = "python3", private readonly defaults: LLMChatOptions = {}, private readonly environment: NodeJS.ProcessEnv = { ...process.env }) {}

  async status(): Promise<ClaudeStatus> {
    let result: ClaudeStatus | undefined;
    await this.run(["--status"], undefined, (value) => {
      if (value.type === "error") throw new Error(String(value.message));
      result = value as unknown as ClaudeStatus;
    }, { timeoutMs: 25_000 });
    if (!result || typeof result.loggedIn !== "boolean") throw new Error("Invalid Claude auth status");
    return result;
  }
  async healthCheck(): Promise<boolean> {
    const status = await this.status();
    return status.available && status.loggedIn && status.subscription;
  }
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
    return this.chatStream(messages, () => {}, options);
  }
  async chatStream(messages: LLMMessage[], onChunk: StreamProgressCallback, options: LLMChatOptions = {}): Promise<LLMResponse> {
    options = { ...this.defaults, ...options };
    const request = prepareRequest(options.model ?? this.model, messages, options);
    let response: LLMResponse | undefined;
    let emitted = "";
    await this.run([], request, (event) => {
      if (response) throw new Error("Unexpected event after completion");
      if (event.type === "text" && typeof event.text === "string") {
        emitted += event.text;
        onChunk({ content: event.text, done: false });
      }
      else if (event.type === "error") throw new Error(String(event.message));
      else if (event.type === "response") response = parseResponse(event.response as NativeResponse, request, options);
      else throw new Error("Unknown Claude transport event");
    }, options);
    if (!response) throw new Error("Claude stream ended without a complete response");
    if (emitted !== response.content) throw new Error("Claude final response differs from streamed text");
    // Publish tool calls only after native completion, usage validation AND bridge exit.
    onChunk({ content: "", done: true, toolCalls: response.toolCalls });
    return response;
  }
  forkForSession(): ClaudeSubscriptionProvider { return new ClaudeSubscriptionProvider(this.model, this.python, this.defaults, this.environment); }
  dispose(): void { this.closed = true; for (const controller of this.active) controller.abort(); }

  private async run(args: string[], input: unknown, onEvent: (value: Record<string, unknown>) => void, options: LLMChatOptions): Promise<void> {
    if (this.closed) throw new Error("Claude provider is closed");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) throw new Error("Invalid Claude timeout");
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let child: ChildProcessWithoutNullStreams | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(abort, options.timeoutMs ?? 120_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child = spawn(this.python, [bridgePath(), ...args], { stdio: "pipe", env: { ...this.environment, PYTHONDONTWRITEBYTECODE: "1" } });
        let buffer = "";
        let failure: Error | undefined;
        const stop = () => {
          child?.kill("SIGTERM");
          killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 7000);
        };
        controller.signal.addEventListener("abort", stop, { once: true });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data: string) => {
          if (failure) return;
          try {
            buffer += data;
            if (buffer.length > 32 * 1024 * 1024) throw new Error("Claude transport frame too large");
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              if (line.trim()) onEvent(JSON.parse(line));
            }
          } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); stop(); }
        });
        // Native diagnostics may contain prompt/account data. Never echo them.
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", reject);
        child.on("close", (code) => {
          controller.signal.removeEventListener("abort", stop);
          if (failure) reject(failure);
          else if (controller.signal.aborted) reject(new Error("Claude request cancelled or timed out"));
          else if (code !== 0 || buffer.trim()) reject(new Error(`Claude bridge failed (exit ${code})`));
          else resolve();
        });
        child.stdin.end(input === undefined ? "" : JSON.stringify(input) + "\n");
      });
    } finally {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }
}
