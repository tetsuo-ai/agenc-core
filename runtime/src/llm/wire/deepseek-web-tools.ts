import { isRecord } from "../../utils/record.js";
import type { LLMProviderEvidence } from "../types.js";

const ENVELOPE = "deepseek_app_tools_v1";

export interface DeepSeekWebReplay {
  readonly content: string;
  readonly reasoning_content?: string;
  readonly server_tool_calls?: readonly Record<string, unknown>[];
  readonly annotations?: readonly Record<string, unknown>[];
}

/** Same provider/model-bound durable carrier used for other opaque provider replay formats. */
export function encodeDeepSeekWebReplay(message: Record<string, unknown>): string {
  return JSON.stringify({ [ENVELOPE]: {
    content: typeof message.content === "string" ? message.content : "",
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
    ...(Array.isArray(message.server_tool_calls) ? { server_tool_calls: message.server_tool_calls } : {}),
    ...(Array.isArray(message.annotations) ? { annotations: message.annotations } : {}),
  } });
}

export function decodeDeepSeekWebReplay(content: string | undefined): DeepSeekWebReplay | undefined {
  if (!content?.startsWith(`{"${ENVELOPE}":`)) return undefined;
  try {
    const root: unknown = JSON.parse(content);
    const value = isRecord(root) ? root[ENVELOPE] : undefined;
    if (!isRecord(value) || typeof value.content !== "string" ||
        (value.reasoning_content !== undefined && typeof value.reasoning_content !== "string") ||
        (value.server_tool_calls !== undefined && (!Array.isArray(value.server_tool_calls) || !value.server_tool_calls.every(isRecord))) ||
        (value.annotations !== undefined && (!Array.isArray(value.annotations) || !value.annotations.every(isRecord)))) return undefined;
    // Only protocol fields can escape the envelope. Nested provider blocks stay byte-for-byte values.
    return {
      content: value.content,
      ...(typeof value.reasoning_content === "string" ? { reasoning_content: value.reasoning_content } : {}),
      ...(value.server_tool_calls !== undefined ? { server_tool_calls: value.server_tool_calls as Record<string, unknown>[] } : {}),
      ...(value.annotations !== undefined ? { annotations: value.annotations as Record<string, unknown>[] } : {}),
    };
  } catch { return undefined; }
}

export function deepSeekWebCalls(steps: unknown): Record<string, unknown>[] {
  return Array.isArray(steps) ? steps.flatMap(step =>
    isRecord(step) && Array.isArray(step.calls) ? step.calls.filter(isRecord) : []) : [];
}

function displayText(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/[\\`*_{}\[\]<>]/gu, "\\$&") : "";
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href.replace(/[()<>]/gu, char => encodeURIComponent(char).replace(/\(/gu, "%28").replace(/\)/gu, "%29"))
      : undefined;
  } catch { return undefined; }
}

export function deepSeekWebStep(call: Record<string, unknown>): string {
  const action = isRecord(call.action) ? call.action : {};
  const target = Array.isArray(action.queries) ? action.queries.map(displayText).join("; ") : displayText(action.url);
  const label = action.type === "search" ? "Web search" : action.type === "find_in_page" ? "Find in page" : "Read page";
  const pattern = typeof action.pattern === "string" ? ` (${displayText(action.pattern)})` : "";
  const error = call.status === "failed" ? ` [${displayText(isRecord(call.error) ? call.error.code : "failed") || "failed"}]` : "";
  return `${label}: ${target || displayText(call.kind)}${pattern}${error}`;
}

/** Display is a projection. The original answer, offsets and signed blocks live only in replay. */
export function renderDeepSeekWebResponse(message: DeepSeekWebReplay): string {
  const steps = deepSeekWebCalls(message.server_tool_calls).map(call => `- ${deepSeekWebStep(call)}`);
  const sources: string[] = [];
  const seen = new Set<string>();
  const markers = new Map<number, number[]>();
  const points = Array.from(message.content);
  for (const annotation of message.annotations ?? []) {
    const citation = annotation.type === "url_citation" && isRecord(annotation.url_citation) ? annotation.url_citation : undefined;
    const url = webUrl(citation?.url);
    if (!url || !citation) continue;
    if (!seen.has(url)) {
      seen.add(url);
      sources.push(`[${displayText(citation.title) || url}](<${url}>)`);
    }
    const number = [...seen].indexOf(url) + 1;
    const end = citation.end_index;
    if (typeof end === "number" && Number.isSafeInteger(end) && end >= 0 && end <= points.length &&
        typeof citation.start_index === "number" && citation.start_index >= 0 && citation.start_index <= end) {
      const at = markers.get(end) ?? [];
      if (!at.includes(number)) at.push(number);
      markers.set(end, at);
    }
  }
  for (const [at, numbers] of [...markers].sort(([a], [b]) => b - a)) {
    points.splice(at, 0, numbers.map(number => ` [${number}]`).join(""));
  }
  return [steps.length ? steps.join("\n") : "", points.join(""),
    sources.length ? `Sources:\n${sources.map((source, index) => `${index + 1}. ${source}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** These are billed units, not result-block/display counters. Fetches have the same tariff. */
export function deepSeekWebUsage(usage: Record<string, unknown>): { count: number; evidence: LLMProviderEvidence["serverSideToolUsage"] } | undefined {
  if (!isRecord(usage.server_tool_use)) return undefined;
  const evidence = ["tool_search", "tool_fetch", "tool_image_search"].flatMap(category => {
    const count = (usage.server_tool_use as Record<string, unknown>)[category];
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? [{ category, toolType: "web_search" as const, count }] : [];
  });
  return { count: evidence.reduce((sum, entry) => sum + entry.count, 0), evidence };
}

export function deepSeekWebEvidence(message: DeepSeekWebReplay, usage: Record<string, unknown>): LLMProviderEvidence {
  return {
    citations: (message.annotations ?? []).flatMap(annotation => {
      const citation = isRecord(annotation.url_citation) ? annotation.url_citation : undefined;
      const url = webUrl(citation?.url);
      return url ? [url] : [];
    }),
    serverSideToolCalls: deepSeekWebCalls(message.server_tool_calls).map(call => ({
      type: "web_search_call", toolType: "web_search",
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      ...(typeof call.type === "string" ? { functionName: call.type } : {}),
      ...(typeof call.status === "string" ? { status: call.status } : {}),
      ...(isRecord(call.action) ? { arguments: JSON.stringify(call.action) } : {}),
      // Never expose encrypted page signatures in a display/evidence record.
    })),
    serverSideToolUsage: deepSeekWebUsage(usage)?.evidence,
  };
}

/** Progress events are display only. Only the terminal delta is authoritative replay. */
export class DeepSeekWebStream {
  private lastReasoning: string | undefined;
  private steps: unknown;
  private annotations: unknown;

  push(choice: Record<string, unknown>, delta: Record<string, unknown>): string | undefined {
    if (typeof delta.reasoning_content === "string") this.lastReasoning = (this.lastReasoning ?? "") + delta.reasoning_content;
    if (Array.isArray(delta.server_tool_calls)) this.steps = delta.server_tool_calls;
    if (Array.isArray(delta.annotations)) this.annotations = delta.annotations;
    const event = isRecord(choice.server_tool_event) ? choice.server_tool_event : undefined;
    if (event?.type === "step_reasoning_done" && this.lastReasoning !== undefined) this.lastReasoning = "";
    return event?.type === "call_started" && isRecord(event.call) ? `- ${deepSeekWebStep(event.call)}\n` : undefined;
  }

  messageFields(): Record<string, unknown> {
    return {
      ...(this.lastReasoning !== undefined ? { reasoning_content: this.lastReasoning } : {}),
      ...(this.steps !== undefined ? { server_tool_calls: this.steps } : {}),
      ...(this.annotations !== undefined ? { annotations: this.annotations } : {}),
    };
  }
}
