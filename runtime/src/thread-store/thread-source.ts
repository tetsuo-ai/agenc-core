import type { ThreadSource } from "./store.js";

const AGENT_THREAD_SOURCE_LABELS = new Set(["agent", "agent_thread"]);
const AGENT_THREAD_SOURCE_KINDS = new Set([
  "agent",
  "agent_thread",
  "thread_spawn",
]);

function isThreadSourceRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function threadSourceStringField(
  source: ThreadSource | Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (!isThreadSourceRecord(source)) return undefined;
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function agentIdFromThreadSource(
  source: ThreadSource | undefined,
): string | undefined {
  if (!isThreadSourceRecord(source)) return undefined;
  const direct =
    threadSourceStringField(source, "agentId") ??
    threadSourceStringField(source, "agent_id");
  if (direct !== undefined) return direct;
  const nested = source.source;
  if (!isThreadSourceRecord(nested)) return undefined;
  return (
    threadSourceStringField(nested, "agentId") ??
    threadSourceStringField(nested, "agent_id") ??
    threadSourceStringField(nested, "parentThreadId")
  );
}

export function agentIdFromThreadSourceJson(
  raw: string | null,
): string | undefined {
  if (raw === null) return undefined;
  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof source !== "string" && !isThreadSourceRecord(source)) {
    return undefined;
  }
  return agentIdFromThreadSource(source);
}

export function isAgentThreadSource(source: ThreadSource | undefined): boolean {
  if (source !== undefined && typeof source === "string") {
    return AGENT_THREAD_SOURCE_LABELS.has(source);
  }
  if (!isThreadSourceRecord(source)) return false;
  const kind = threadSourceStringField(source, "kind");
  if (kind !== undefined && AGENT_THREAD_SOURCE_KINDS.has(kind)) return true;
  const nested = source.source;
  return (
    isThreadSourceRecord(nested) &&
    threadSourceStringField(nested, "kind") === "thread_spawn"
  );
}
