/**
 * `TodoWrite` tool — model-driven main-thread progress tracker.
 *
 * Contract:
 *   - Input: `{ todos: TodoItem[] }` where each item is
 *     `{ content: string, status: "pending" | "in_progress" | "completed",
 *        activeForm: string }`. Position-ordered. No IDs.
 *   - The call atomically replaces the whole list. Not a patch.
 *   - If every item is `completed`, the store clears the list entirely.
 *   - Output is the verbatim upstream success text:
 *     `"Todos have been modified successfully. Ensure that you continue
 *       to use the todo list to track your progress. Please proceed with
 *       the current tasks if applicable"`.
 *
 * The tool description and result text are part of the model contract
 * and are reproduced verbatim from the upstream reference runtime so a
 * model trained against upstream behavior responds the same way here.
 *
 * Distinct from AgenC's `task.*` tool family, which handles subagent
 * orchestration with IDs, blocking relationships, and ownership.
 * TodoWrite is the lightweight main-thread progress tracker.
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { TodoItem, TodoStatus } from "./todo-store.js";
import { TodoStore } from "./todo-store.js";

export const TODO_WRITE_TOOL_NAME = "TodoWrite";

export const TODO_WRITE_SESSION_ARG = "__agencTodoSessionId";

const TODO_WRITE_DESCRIPTION =
  "Use TodoWrite to track multi-step work on the main conversation " +
  "thread. Replaces the whole todo list atomically. Statuses are " +
  "`pending`, `in_progress`, `completed` — exactly one item should be " +
  "`in_progress` at a time. `activeForm` is a present-continuous label " +
  "(e.g. \"Running tests\"). When every item is marked `completed`, the " +
  "runtime clears the list. " +
  "Distinct from the `task.*` tool family, which is for delegating work " +
  "to subagents with IDs, blocking relationships, and ownership. Use " +
  "TodoWrite for your own progress; use `task.create` when spawning " +
  "child agents or managing cross-agent dependencies.";

const TODO_WRITE_SUCCESS_TEXT =
  "Todos have been modified successfully. Ensure that you continue to " +
  "use the todo list to track your progress. Please proceed with the " +
  "current tasks if applicable";

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseTodos(raw: unknown): TodoItem[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "todos must be an array" };
  }
  const out: TodoItem[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `todos[${index}] must be an object` };
    }
    const candidate = entry as Record<string, unknown>;
    if (!isNonEmptyString(candidate.content)) {
      return { error: `todos[${index}].content must be a non-empty string` };
    }
    if (!isNonEmptyString(candidate.activeForm)) {
      return {
        error: `todos[${index}].activeForm must be a non-empty string`,
      };
    }
    if (!isTodoStatus(candidate.status)) {
      return {
        error:
          `todos[${index}].status must be one of "pending", "in_progress", ` +
          `"completed"`,
      };
    }
    // Reject extra keys to match upstream's `z.strictObject` input schema.
    for (const key of Object.keys(candidate)) {
      if (key !== "content" && key !== "activeForm" && key !== "status") {
        return { error: `todos[${index}] has unexpected key "${key}"` };
      }
    }
    out.push({
      content: candidate.content,
      activeForm: candidate.activeForm,
      status: candidate.status,
    });
  }
  return out;
}

function resolveSessionId(args: Record<string, unknown>): string | undefined {
  const value = args[TODO_WRITE_SESSION_ARG];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

export function createTodoWriteTool(store: TodoStore): Tool {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description: TODO_WRITE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The todo item text (imperative form).",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current state of the item.",
              },
              activeForm: {
                type: "string",
                description:
                  "Present-continuous form shown while the item is " +
                  "in_progress (e.g. \"Running tests\").",
              },
            },
            required: ["content", "status", "activeForm"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    metadata: {
      family: "workflow",
      source: "builtin",
      mutating: true,
      hiddenByDefault: false,
    },
    async execute(args) {
      const sessionId = resolveSessionId(args);
      if (!sessionId) {
        return errorResult(
          "TodoWrite requires a session scope. The runtime injects " +
            "it via the tool handler context.",
        );
      }
      const parsed = parseTodos(args.todos);
      if (!Array.isArray(parsed)) {
        return errorResult(parsed.error);
      }
      const result = await store.setTodos(sessionId, parsed);
      return {
        content: safeStringify({
          message: TODO_WRITE_SUCCESS_TEXT,
          oldTodos: result.oldTodos,
          newTodos: result.newTodos,
        }),
      };
    },
  };
}
