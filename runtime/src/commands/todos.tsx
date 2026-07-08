import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { getSessionId } from "../bootstrap/state.js";

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoRow {
  readonly content: string;
  readonly status: TodoStatus;
}

interface TodoListEntry {
  readonly agentId: string;
  readonly isRoot: boolean;
  readonly todos: readonly TodoRow[];
}

const STATUS_MARKS: Readonly<Record<TodoStatus, string>> = {
  pending: "◇",
  in_progress: "◆",
  completed: "✓",
};

function normalizeStatus(value: unknown): TodoStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : null;
}

function parseTodoRows(value: unknown): readonly TodoRow[] {
  if (!Array.isArray(value)) return [];
  const rows: TodoRow[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const status = normalizeStatus(record.status);
    if (status === null || typeof record.content !== "string") continue;
    rows.push({ content: record.content, status });
  }
  return rows;
}

/**
 * Keys under which the root agent's todo list is stored. The TodoWrite tool
 * keys the root list by session id (`context.agentId ?? getSessionId()`);
 * subagent lists are keyed by their agent id.
 */
function rootTodoKeys(ctx: SlashCommandContext): ReadonlySet<string> {
  const keys = new Set<string>();
  try {
    keys.add(getSessionId());
  } catch {
    // Bootstrap state may be unavailable in headless/test contexts.
  }
  const conversationId = (ctx.session as { conversationId?: unknown }).conversationId;
  if (typeof conversationId === "string") keys.add(conversationId);
  return keys;
}

function readTodoEntries(ctx: SlashCommandContext): readonly TodoListEntry[] | null {
  const state = ctx.appState?.getAppState?.();
  if (typeof state !== "object" || state === null) return null;
  const todos = (state as { todos?: unknown }).todos;
  if (typeof todos !== "object" || todos === null) return [];
  const rootKeys = rootTodoKeys(ctx);
  const entries: TodoListEntry[] = [];
  for (const [agentId, list] of Object.entries(todos)) {
    const rows = parseTodoRows(list);
    if (rows.length === 0) continue;
    entries.push({ agentId, isRoot: rootKeys.has(agentId), todos: rows });
  }
  // Root agent's list first, then subagent lists in stable id order.
  return entries.sort((a, b) =>
    a.isRoot !== b.isRoot ? (a.isRoot ? -1 : 1) : a.agentId.localeCompare(b.agentId),
  );
}

function countByStatus(rows: readonly TodoRow[], status: TodoStatus): number {
  return rows.filter((row) => row.status === status).length;
}

function todoListText(entries: readonly TodoListEntry[] | null): string {
  if (entries === null) return "Todo state is not available in this session.";
  if (entries.length === 0) return "No todos recorded this session.";

  const allRows = entries.flatMap((entry) => entry.todos);
  const lines = [
    "AgenC Todos",
    `${allRows.length} todos · ${countByStatus(allRows, "in_progress")} in progress · ${countByStatus(allRows, "completed")} completed`,
  ];
  for (const entry of entries) {
    lines.push("", entry.isRoot ? "Current session:" : `Agent ${entry.agentId}:`);
    for (const row of entry.todos) {
      lines.push(`  ${STATUS_MARKS[row.status]} ${row.content}`);
    }
  }
  return lines.join("\n");
}

export const todosCommand: SlashCommand = {
  name: "todos",
  aliases: ["todo"],
  description: "Show the session todo lists",
  supportedSurfaces: ["runtime", "daemon-tui"],
  userInvocable: true,
  immediate: true,
  execute: (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => ({ kind: "text", text: todoListText(readTodoEntries(ctx)) })),
};
