/**
 * gpt-oss tool calls that a host returned as harmony text.
 *
 * gpt-oss writes its output in OpenAI's harmony format, and the host that
 * serves it turns each `commentary to=functions.<name> ... <|message|>{args}<|call|>`
 * segment into a structured tool call. Some routed hosts (seen on
 * OpenRouter) fail to parse a call and return the raw harmony text as the
 * answer instead, for example:
 *
 *   ` to=files\n\nWe have a third file ...<|end|><|start|>assistant<|channel|>commentary to=functions.FileRead <|constrain|>json<|message|>{"file_path":"notes/c.txt"}<|call|>`
 *
 * Taken as it is, that text ends the turn as the model's final answer. A
 * harmony call ends the model's output (the model stops at `<|call|>` and
 * waits for the result), so a complete call at the very end of the text, to
 * a tool the request advertised, with a JSON object as its arguments, is
 * the call the model made. Anything less complete is left as it is.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

const GPT_OSS_MODEL = /(?:^|[/:_-])gpt-oss(?:$|[-_.:])/iu;
const CALL_END = "<|call|>";
const RECIPIENT = "to=functions.";
const TOOL_NAME = /^[A-Za-z0-9_.:-]+/u;
const HARMONY_HEADER = /<\|start\|>\s*assistant|<\|channel\|>\s*(?:analysis|commentary|final)\b/gu;
const HARMONY_TOKEN = /<\|(?:start|end|channel|message|constrain|call|return)\|>/gu;

/** An open-weight gpt-oss model under any host's naming. */
export function isGptOssModel(model: string): boolean {
  return GPT_OSS_MODEL.test(model.trim());
}

export interface LeakedHarmonyToolCall {
  readonly name: string;
  /** The call's arguments, a JSON object. */
  readonly arguments: string;
  /** The text before the call with the harmony markers removed. */
  readonly reasoning: string;
}

/** The complete harmony call at the end of `content`, if there is one. */
export function recoverLeakedHarmonyToolCall(
  content: string,
  advertisedToolNames: readonly string[],
): LeakedHarmonyToolCall | undefined {
  const text = content.trimEnd();
  if (!text.endsWith(CALL_END)) return undefined;
  const at = text.lastIndexOf(RECIPIENT);
  if (at < 0) return undefined;
  // After the recipient: the tool name, an optional content type, an optional
  // message marker, then the arguments up to `<|call|>`. Hosts that drop the
  // channel header leave the bare ` to=functions.<name> {args}<|call|>`.
  const call = text.slice(at + RECIPIENT.length, text.length - CALL_END.length);
  const name = TOOL_NAME.exec(call)?.[0];
  if (name === undefined || !advertisedToolNames.includes(name)) return undefined;
  const body = call
    .slice(name.length)
    .replace(/^\s*<\|constrain\|>\s*[A-Za-z]+/u, "")
    .replace(/^\s*<\|message\|>/u, "")
    .trim();
  const parsed = jsonObject(body);
  if (parsed === undefined) return undefined;
  const reasoning = text
    .slice(0, at)
    // What is left of a header the host cut off, for example ` to=files`.
    .replace(/^\s*to=\S*/u, "")
    .replace(HARMONY_HEADER, "\n")
    .replace(HARMONY_TOKEN, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { name, arguments: JSON.stringify(parsed), reasoning };
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Some hosts also parse gpt-oss's analysis text into an extra tool call (a
 * name like `...` and prose as its arguments) next to the real one. When a
 * response has a valid call to an advertised tool, calls that are neither
 * advertised nor carry JSON arguments are that analysis, not calls.
 */
export function withoutHarmonyAnalysisCalls<T extends { readonly name: string; readonly arguments: string }>(
  model: string,
  calls: readonly T[],
  advertisedToolNames: readonly string[],
): { readonly calls: readonly T[]; readonly analysis: string } {
  if (!isGptOssModel(model) || calls.length < 2) return { calls, analysis: "" };
  const advertised = (call: T) => advertisedToolNames.includes(call.name);
  const jsonArguments = (call: T) => call.arguments.trim().length === 0 || jsonObject(call.arguments.trim()) !== undefined;
  if (!calls.some((call) => advertised(call) && jsonArguments(call))) return { calls, analysis: "" };
  const isAnalysis = (call: T) => !advertised(call) && !jsonArguments(call);
  const analysis = calls.filter(isAnalysis);
  if (analysis.length === 0) return { calls, analysis: "" };
  return {
    calls: calls.filter((call) => !isAnalysis(call)),
    analysis: analysis.map((call) => call.arguments.trim()).filter((text) => text.length > 0).join("\n"),
  };
}

/**
 * A gpt-oss Chat Completions message with its tool call recovered: a call
 * that came back as harmony text becomes the structured call, and analysis a
 * host parsed into an extra call goes back to reasoning. Any other message
 * is returned unchanged.
 */
export function withRecoveredHarmonyToolCall(
  model: string,
  message: Record<string, unknown>,
  advertisedToolNames: readonly string[],
  reasoningField: string,
): Record<string, unknown> {
  if (!isGptOssModel(model)) return message;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const wire = message.tool_calls as Array<Record<string, unknown>>;
    const view = wire.map((call, index) => {
      const fn = (call.function ?? {}) as Record<string, unknown>;
      return { index, name: String(fn.name ?? ""), arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
    });
    const { calls, analysis } = withoutHarmonyAnalysisCalls(model, view, advertisedToolNames);
    if (calls.length === view.length) return message;
    const existing = typeof message[reasoningField] === "string" ? message[reasoningField] as string : "";
    const reasoning = [existing, analysis].filter((text) => text.length > 0).join("\n");
    return {
      ...message,
      ...(reasoning.length > 0 ? { [reasoningField]: reasoning } : {}),
      tool_calls: calls.map((call) => wire[call.index]),
    };
  }
  if (typeof message.content !== "string") return message;
  const recovered = recoverLeakedHarmonyToolCall(message.content, advertisedToolNames);
  if (recovered === undefined) return message;
  const existing = typeof message[reasoningField] === "string" ? message[reasoningField] as string : "";
  const reasoning = [existing, recovered.reasoning].filter((text) => text.length > 0).join("\n");
  return {
    ...message,
    content: "",
    ...(reasoning.length > 0 ? { [reasoningField]: reasoning } : {}),
    tool_calls: [{
      id: `call_harmony_${randomUUID().replace(/-/gu, "").slice(0, 16)}`,
      type: "function",
      function: { name: recovered.name, arguments: recovered.arguments },
    }],
  };
}

/**
 * Holds back a streamed gpt-oss answer that starts the way leaked harmony
 * text does (` to=files`, ` to=functions.FileRead`) until the response
 * ends, so a call recovered from it does not first appear as an answer in
 * the transcript. Every other answer streams as it arrives; held text that
 * does not turn into a call is shown when the response ends.
 */
export class HarmonyLeakHold {
  #state: "deciding" | "holding" | "passing";
  #held = "";

  constructor(model: string) {
    this.#state = isGptOssModel(model) ? "deciding" : "passing";
  }

  /** The part of `text` to show now. */
  push(text: string): string {
    if (this.#state === "passing") return text;
    this.#held += text;
    if (this.#state === "holding") return "";
    const lead = this.#held.trimStart();
    if (lead.startsWith("to=")) {
      this.#state = "holding";
      return "";
    }
    if (lead.length < 3 && "to=".startsWith(lead)) return "";
    return this.flush();
  }

  /** Whatever is still held; streaming passes through from here on. */
  flush(): string {
    const held = this.#held;
    this.#held = "";
    this.#state = "passing";
    return held;
  }
}
