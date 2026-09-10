import { describe, expect, it } from "vitest";
import { collapseReadSearchGroups } from "../../src/utils/collapseReadSearch.js";
import { shellOperationIdentity } from "../../src/tui/shell-operation-identity.js";
import { isFixedRerunSuccess } from "../../src/tui/message-renderers/fixedRerunLink.js";

function attempt(id: string, name: string, input: unknown): never {
  return { type: "assistant", uuid: id, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } } as never;
}

function failure(id: string): never {
  return { type: "user", uuid: `${id}-result`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "failed" }] } } as never;
}

describe("retry identity", () => {
  it("preserves shell effect arguments and accepts reordered JSON objects", () => {
    const original = shellOperationIdentity("exec_command", { cmd: "node --test", workdir: "/project", env: { MODE: "test", FLAG: "1" } });
    expect(shellOperationIdentity("exec_command", { env: { FLAG: "1", MODE: "test" }, workdir: "/project", cmd: "node --test", justification: "retry", yield_time_ms: 30000 })).toBe(original);
    expect(shellOperationIdentity("exec_command", { cmd: "node --test", workdir: "/project", env: { MODE: "production", FLAG: "1" } })).not.toBe(original);
    expect(shellOperationIdentity("Run", { command: "node", args: ["one.js"] })).not.toBe(shellOperationIdentity("Run", { command: "node", args: ["two.js"] }));
    const recursive: Record<string, unknown> = { cmd: "node" };
    recursive.self = recursive;
    expect(shellOperationIdentity("exec_command", recursive)).toBeNull();
  });

  it("uses the same scoped identity for fixed rerun annotations", () => {
    const previous = { id: "previous", name: "exec_command", input: { cmd: "node --test", workdir: "/first" } };
    const current = { id: "current", name: "exec_command", input: { cmd: "node --test", workdir: "/second" } };
    const lookups = { toolUseByToolUseID: new Map([[previous.id, previous], [current.id, current]]), resolvedToolUseIDs: new Set([previous.id, current.id]), erroredToolUseIDs: new Set([previous.id]) };
    expect(isFixedRerunSuccess(current, lookups as never)).toBe(false);
    expect(isFixedRerunSuccess({ ...current, input: previous.input }, lookups as never)).toBe(true);
  });

  it.each([
    ["exec_command", { cmd: "node --test" }, { cmd: "git status" }],
    ["exec_command", { cmd: "node --test", workdir: "/first" }, { cmd: "node --test", workdir: "/second" }],
    ["Bash", { command: "node --test", cwd: "/first" }, { command: "node --test", cwd: "/second" }],
    ["Run", { command: ["node", "--test"] }, { command: ["node", "app.js"] }],
    ["custom_tool", { query: "first" }, { query: "second" }],
    ["exec_command", {}, {}],
  ])("does not merge distinct or unidentifiable %s calls", (name, first, second) => {
    const rows = collapseReadSearchGroups([attempt("first", name, first), failure("first"), attempt("second", name, second)], [{ name }] as never, false);
    expect(rows.filter(row => row.type === "assistant")).toHaveLength(2);
  });
});
