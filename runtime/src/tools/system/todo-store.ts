/**
 * Per-session todo list for the `TodoWrite` tool.
 *
 * The `TodoWrite` tool is the model's main-thread progress tracker:
 * simple 3-state items (`pending` / `in_progress` / `completed`),
 * position-ordered, no IDs. The model writes the whole list at once;
 * the runtime persists it per-session so it survives webchat resume.
 *
 * This file is deliberately small. The tool's behavior is:
 *   - Atomic replacement of the whole list (no patches).
 *   - If every item is `completed`, the store clears the list entirely
 *     (matches the upstream reference runtime's completion semantic).
 *   - Reads return an empty array for an unknown session.
 *
 * The richer `task.*` tool family (`SessionTaskStore` in `task-tracker.ts`)
 * stays as the sub-agent orchestration tool with IDs, blocking
 * relationships, and ownership. Todo items here are intentionally the
 * model's scratch list for its own work.
 *
 * @module
 */

import type { MemoryBackend } from "../../memory/types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly activeForm: string;
}

export interface TodoWriteResult {
  readonly oldTodos: readonly TodoItem[];
  readonly newTodos: readonly TodoItem[];
}

const TODO_STORE_KEY_PREFIX = "todo:list:";

function todoKey(sessionId: string): string {
  return `${TODO_STORE_KEY_PREFIX}${sessionId}`;
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((item) => ({
    content: item.content,
    status: item.status,
    activeForm: item.activeForm,
  }));
}

function allCompleted(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((item) => item.status === "completed");
}

export interface TodoStoreOptions {
  readonly memoryBackend?: MemoryBackend;
}

export class TodoStore {
  private readonly memoryBackend?: MemoryBackend;
  private readonly lists = new Map<string, TodoItem[]>();

  constructor(options: TodoStoreOptions = {}) {
    this.memoryBackend = options.memoryBackend;
  }

  async getTodos(sessionId: string): Promise<readonly TodoItem[]> {
    const cached = this.lists.get(sessionId);
    if (cached) return cloneTodos(cached);
    if (!this.memoryBackend) return [];
    const persisted = await this.memoryBackend.get<readonly TodoItem[]>(
      todoKey(sessionId),
    );
    if (!Array.isArray(persisted)) return [];
    const normalized: TodoItem[] = [];
    for (const entry of persisted) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<TodoItem>;
      if (
        typeof candidate.content !== "string" ||
        typeof candidate.activeForm !== "string"
      ) {
        continue;
      }
      if (
        candidate.status !== "pending" &&
        candidate.status !== "in_progress" &&
        candidate.status !== "completed"
      ) {
        continue;
      }
      normalized.push({
        content: candidate.content,
        status: candidate.status,
        activeForm: candidate.activeForm,
      });
    }
    this.lists.set(sessionId, normalized);
    return cloneTodos(normalized);
  }

  async setTodos(
    sessionId: string,
    todos: readonly TodoItem[],
  ): Promise<TodoWriteResult> {
    const oldTodos = await this.getTodos(sessionId);
    const next = allCompleted(todos) ? [] : cloneTodos(todos);
    this.lists.set(sessionId, next);
    if (this.memoryBackend) {
      if (next.length === 0) {
        await this.memoryBackend.delete(todoKey(sessionId));
      } else {
        await this.memoryBackend.set(todoKey(sessionId), next);
      }
    }
    return {
      oldTodos,
      newTodos: cloneTodos(next),
    };
  }

  async clearTodos(sessionId: string): Promise<void> {
    this.lists.delete(sessionId);
    if (this.memoryBackend) {
      await this.memoryBackend.delete(todoKey(sessionId));
    }
  }
}
