import { isTodoPlanMirror } from "./timeline-capabilities.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { SessionTranscriptV2Result } from "./protocol/index.js";

type Turn = NonNullable<SessionTranscriptV2Result["turns"]>[number];
type Call = Turn["toolCalls"][number];
const TARGETS = ["command", "cmd", "path", "file_path", "url", "pattern", "query", "description"];

/** Target preview only. Never persist content, replacement text or outputs. */
export function toolInputDigest(args: string): Record<string, string> {
  const digest: Record<string, string> = {};
  if (args.length > 64 * 1024) return digest;
  try {
    const value = JSON.parse(args);
    let remaining = 1024;
    for (const key of TARGETS) {
      if (remaining <= 0) break;
      if (typeof value?.[key] !== "string") continue;
      digest[key] = value[key].slice(0, Math.min(512, remaining));
      remaining -= digest[key]!.length;
    }
  } catch { /* Malformed inputs have no safe digest. */ }
  return digest;
}

/** Bounded display projection over the same visible history as snapshot v2. */
export function transcriptV3Turns(items: readonly RolloutItem[], boundaryIndex: number): {
  turns: Turn[]; turnsTruncated?: true;
} {
  const turns: Turn[] = [];
  const calls = new Map<string, { turn: Turn; index: number }>();
  const pendingTodos = new Map<string, { todos: NonNullable<Turn["todos"]>; truncated: boolean }>();
  let current: Turn | undefined;
  let truncated = false;
  for (let i = boundaryIndex + 1; i < items.length; i++) {
    const item = items[i]!;
    if (item.type !== "event_msg") continue;
    const msg = item.payload.msg;
    if (isTodoPlanMirror(msg.type, msg.payload)) continue;
    if (msg.type === "turn_started") {
      current = turns.find(turn => turn.turnId === msg.payload.turnId);
      if (!current) {
        current = { turnId: msg.payload.turnId, toolCalls: [] };
        turns.push(current);
        if (turns.length > 128) { turns.shift(); truncated = true; }
      }
      calls.clear();
      pendingTodos.clear();
      current.toolCalls.forEach((call, index) => calls.set(call.callId, { turn: current!, index }));
    } else if (msg.type === "tool_call_started" && current) {
      if (calls.has(msg.payload.callId)) continue;
      if (msg.payload.toolName === "TodoWrite" && msg.payload.args.length <= 64 * 1024) {
        try {
          const input = JSON.parse(msg.payload.args);
          if (Array.isArray(input.todos)) {
            const todos: NonNullable<Turn["todos"]> = input.todos.slice(0, 128).flatMap((todo: any) =>
              typeof todo?.content === "string" && ["pending", "in_progress", "completed"].includes(todo.status)
                ? [{ text: todo.content.slice(0, 512), state: todo.status === "completed" ? "done" : todo.status === "in_progress" ? "running" : "pending" }] : []);
            if (pendingTodos.size >= 128) { pendingTodos.delete(pendingTodos.keys().next().value!); truncated = true; }
            pendingTodos.set(msg.payload.callId, { todos, truncated: input.todos.length > 128 || input.todos.some((todo: any) => typeof todo?.content === "string" && todo.content.length > 512) });
          }
        } catch { /* Invalid tool inputs do not replace the last valid list. */ }
      }
      if (current.toolCalls.length >= 128) { truncated = true; continue; }
      const call: Call = { callId: msg.payload.callId.slice(0, 256), toolName: msg.payload.toolName.slice(0, 256), inputDigest: toolInputDigest(msg.payload.args) };
      calls.set(msg.payload.callId, { turn: current, index: current.toolCalls.length });
      (current.toolCalls as Call[]).push(call);
    } else if (msg.type === "tool_call_completed") {
      const pending = pendingTodos.get(msg.payload.callId);
      if (pending && current && !msg.payload.isError) Object.assign(current, { todos: pending.todos, ...(pending.truncated ? { todosTruncated: true } : { todosTruncated: undefined }) });
      pendingTodos.delete(msg.payload.callId);
      const found = calls.get(msg.payload.callId);
      if (found) {
        const call = found.turn.toolCalls[found.index]!;
        (found.turn.toolCalls as Call[])[found.index] = { ...call, isError: msg.payload.isError,
          ...(typeof msg.payload.durationMs === "number" && Number.isFinite(msg.payload.durationMs) && msg.payload.durationMs >= 0 ? { durationMs: msg.payload.durationMs } : {}) };
      }
    } else if (msg.type === "plan_started" && current?.turnId === msg.payload.turnId) {
      Object.assign(current, { plan: { planItemId: msg.payload.planItemId.slice(0, 256), title: msg.payload.title.slice(0, 512), text: "", state: "running" } });
    } else if ((msg.type === "plan_delta" || msg.type === "plan_item_completed") && current?.turnId === msg.payload.turnId && current.plan?.planItemId === msg.payload.planItemId) {
      const text = msg.type === "plan_delta" ? current.plan.text + msg.payload.delta : msg.payload.finalText;
      Object.assign(current, { plan: { ...current.plan, text: text.slice(0, 16384), state: msg.type === "plan_delta" ? "running" : "done", ...(text.length > 16384 || current.plan.truncated ? { truncated: true } : {}) } });
    } else if (["turn_complete", "turn_failed", "turn_aborted"].includes(msg.type) &&
      "turnId" in msg.payload && msg.payload.turnId === current?.turnId) {
      current = undefined;
      calls.clear();
    }
  }
  while (Buffer.byteLength(JSON.stringify(turns)) > 128 * 1024) { turns.shift(); truncated = true; }
  return { turns, ...(truncated ? { turnsTruncated: true as const } : {}) };
}
