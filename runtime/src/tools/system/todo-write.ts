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

const TODO_WRITE_DESCRIPTION = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: *Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: *Uses grep or search tools to locate all instances of getCwd in the codebase*
I've found 15 instances of 'getCwd' across 8 different files.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>


<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: *Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: *Reviews component structure, render patterns, state management, and data fetching*
After analyzing your codebase, I've identified several performance issues.
*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*
Let's start by implementing memoization for the expensive calculations in your ProductList component.

<reasoning>
The assistant used the todo list because:
1. First, the assistant examined the codebase to identify specific performance issues
2. Based on this analysis, it identified multiple optimization opportunities
3. Performance optimization is a non-trivial task requiring multiple steps
4. The todo list helps methodically track improvements across different components
5. This systematic approach ensures all performance bottlenecks are addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

<reasoning>
The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
* Uses the system.editFile tool to add a comment to the calculateTotal function *

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.

*Executes: npm install*

The command completed successfully. Here's the output:
[Output of npm install command]

All dependencies have been installed according to your package.json file.

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
`;

const TODO_WRITE_SUCCESS_TEXT =
  "Todos have been modified successfully. Ensure that you continue to " +
  "use the todo list to track your progress. Please proceed with the " +
  "current tasks if applicable";

const TODO_WRITE_NUDGE_NOTE =
  "\n\nNOTE: You just closed out 3+ tasks and none of them was a " +
  "verification step. Before writing your final summary, spawn the " +
  "verifier with execute_with_agent and set " +
  "delegationAdmission.verifierObligations to the checks you want " +
  "verified. You cannot self-assign PARTIAL by listing caveats in your " +
  "summary \u2014 only the verifier issues a verdict.";

// TodoWrite is wired as a main-thread-only tool; if that ever changes,
// add an actor-kind guard here to avoid nudging subagents.
function shouldEmitTodoNudge(todos: readonly TodoItem[]): boolean {
  if (todos.length < 3) return false;
  if (!todos.every((t) => t.status === "completed")) return false;
  return !todos.some((t) => /verif/i.test(t.content));
}

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
      const nudgeNeeded = shouldEmitTodoNudge(parsed);
      return {
        content: safeStringify({
          message:
            TODO_WRITE_SUCCESS_TEXT + (nudgeNeeded ? TODO_WRITE_NUDGE_NOTE : ""),
          oldTodos: result.oldTodos,
          newTodos: result.newTodos,
        }),
      };
    },
  };
}
