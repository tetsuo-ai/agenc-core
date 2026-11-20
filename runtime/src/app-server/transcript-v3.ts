import { isTodoPlanMirror } from "./timeline-capabilities.js";
import { parsePatch } from "../tools/apply-patch/parser.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { SessionTranscriptV2Result } from "./protocol/index.js";

type Turn = NonNullable<SessionTranscriptV2Result["turns"]>[number];
type Call = Turn["toolCalls"][number];
/** A call's target preview, and the mark for an apply_patch file list that left a file out. */
type CallTargets = Pick<Call, "inputDigest" | "pathsTruncated">;
const TARGETS = ["command", "cmd", "path", "file_path", "url", "pattern", "query", "description"];
const DIGEST_VALUE_MAX = 512;
/** The model-facing name of the patch tool (`APPLY_PATCH_TOOL_NAME`). */
const APPLY_PATCH = "apply_patch";

/**
 * The patch an apply_patch call carries, read as the registry hands it to
 * the tool: the `input` field of a JSON object, or a bare patch or JSON
 * string mapped onto `input`.
 */
function applyPatchText(args: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return args;
  }
  if (typeof value === "string") return value;
  const input = typeof value === "object" && value !== null ? (value as { input?: unknown }).input : undefined;
  return typeof input === "string" ? input : undefined;
}

/**
 * An apply_patch call's targets are the files its patch names, on its
 * `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:`
 * lines, as Core's patch parser reads them. `path` is the file of a patch
 * with one file section (a move keeps the file it moves); `paths` lists every
 * file the patch names, one per line, in patch order, without repeats, whole
 * paths only. When those do not all fit, the call is marked `pathsTruncated`,
 * so a client can say "12 or more files" instead of "12 files". A patch the
 * parser refuses has no safe digest.
 */
function applyPatchTargets(args: string): CallTargets {
  const patch = applyPatchText(args);
  if (patch === undefined) return { inputDigest: {} };
  let hunks: ReturnType<typeof parsePatch>["hunks"];
  try {
    hunks = parsePatch(patch).hunks;
  } catch {
    return { inputDigest: {} };
  }
  const digest: Record<string, string> = {};
  const only = hunks.length === 1 ? hunks[0]!.path : "";
  if (only.length > 0) digest.path = only.slice(0, DIGEST_VALUE_MAX);
  const named: string[] = [];
  for (const hunk of hunks) {
    for (const path of hunk.kind === "update" && hunk.movePath !== null ? [hunk.path, hunk.movePath] : [hunk.path]) {
      if (path.length > 0 && !named.includes(path)) named.push(path);
    }
  }
  let paths = "";
  let listed = 0;
  for (const path of named) {
    const next = paths.length === 0 ? path : `${paths}\n${path}`;
    if (next.length > DIGEST_VALUE_MAX) break;
    paths = next;
    listed += 1;
  }
  if (paths.length > 0) digest.paths = paths;
  return { inputDigest: digest, ...(listed < named.length ? { pathsTruncated: true as const } : {}) };
}

/** Target preview only. Never persist content, replacement text or outputs. */
export function toolInputDigest(args: string, toolName?: string): Record<string, string> {
  return toolCallTargets(args, toolName).inputDigest;
}

function toolCallTargets(args: string, toolName?: string): CallTargets {
  const digest: Record<string, string> = {};
  if (args.length > 64 * 1024) return { inputDigest: digest };
  if (toolName === APPLY_PATCH) return applyPatchTargets(args);
  try {
    const value = JSON.parse(args);
    let remaining = 1024;
    for (const key of TARGETS) {
      if (remaining <= 0) break;
      if (typeof value?.[key] !== "string") continue;
      digest[key] = value[key].slice(0, Math.min(DIGEST_VALUE_MAX, remaining));
      remaining -= digest[key]!.length;
    }
  } catch { /* Malformed inputs have no safe digest. */ }
  return { inputDigest: digest };
}

function recordedUsage(usage: NonNullable<Extract<import("../session/event-log.js").EventMsg, { type: "turn_complete" }>["payload"]["usage"]>): NonNullable<Turn["usage"]> {
  const counters: Record<string, number> = {};
  for (const key of ["input", "output", "cached", "reasoning", "costUsd", "billedEstimateUsd", "planCalls"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) counters[key] = value;
  }
  return { ...counters, mark: Object.keys(counters).length ? "reported" : "missing" };
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
      const call: Call = { callId: msg.payload.callId.slice(0, 256), toolName: msg.payload.toolName.slice(0, 256), ...toolCallTargets(msg.payload.args, msg.payload.toolName) };
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
    } else if (msg.type === "turn_changes") {
      const turn = turns.find(turn => turn.turnId === msg.payload.turnId);
      if (turn) {
        const payload = msg.payload;
        const files = payload.files.slice(0, 256).map(file => ({
          path: file.path.slice(0, 512), op: file.op, added: file.added, removed: file.removed,
          ...(file.binary === true ? { binary: true } : {}),
        }));
        Object.assign(turn, { changes: {
          turnId: payload.turnId, from: "checkpoint", files,
          ...(payload.skipped !== undefined ? { skipped: payload.skipped } : {}),
          ...(payload.note !== undefined ? { note: payload.note.slice(0, 2048) } : {}),
          ...(payload.files.length > 256 || payload.files.some(file => file.path.length > 512) ? { filesTruncated: true } : {}),
        } });
      }
    } else if (["turn_complete", "turn_failed", "turn_aborted"].includes(msg.type) &&
      "turnId" in msg.payload && msg.payload.turnId === current?.turnId) {
      if (msg.type === "turn_complete" && msg.payload.usage !== undefined && current) {
        Object.assign(current, { usage: recordedUsage(msg.payload.usage) });
      }
      current = undefined;
      calls.clear();
    }
  }
  while (Buffer.byteLength(JSON.stringify(turns)) > 128 * 1024) { turns.shift(); truncated = true; }
  return { turns, ...(truncated ? { turnsTruncated: true as const } : {}) };
}
