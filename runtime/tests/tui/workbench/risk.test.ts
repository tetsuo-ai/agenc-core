import { describe, expect, it } from "vitest";

import {
  classifyApprovalRisk,
  typedConfirmationWordForRisk,
} from "../../../src/permissions/risk.js";

describe("approval risk helpers", () => {
  it("classifies low, medium, and destructive requests", () => {
    expect(classifyApprovalRisk({ toolName: "Read", command: "cat README.md" })).toBe("low");
    expect(classifyApprovalRisk({ toolName: "Bash", command: "npm install" })).toBe("medium");
    expect(classifyApprovalRisk({ toolName: "Bash", command: "rm -rf /tmp/project" })).toBe("destructive");
    expect(classifyApprovalRisk({ toolName: "Bash", command: `bash {"script":"rm -rf /tmp/project"}` })).toBe("destructive");
  });

  it.each([
    "rm -fr /tmp/project",
    "rm -r -f /tmp/project",
    "rm --recursive --force /tmp/project",
    "bash -lc 'rm -fr /tmp/project'",
  ])("classifies equivalent forced recursive removals as destructive: %s", (command) => {
    expect(classifyApprovalRisk({ toolName: "Bash", command })).toBe("destructive");
  });

  it("requires specific confirmation words for destructive actions", () => {
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "transfer tokens" })).toBe("transfer");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "delete branch" })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "rm -fr /tmp/project" })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: `bash {"script":"rm -rf /tmp/project"}` })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "medium", command: "npm install" })).toBe("yes");
  });

  it.each([
    ["Grep", { pattern: "app\\.(get|post|put|patch|delete)|createServer|/api", glob: "*.{js,json,md}" }],
    ["Grep", { pattern: "rm -rf|stake|transfer", path: "/project" }],
    ["Glob", { pattern: "**/delete/*.js" }],
    ["FileRead", { file_path: "/project/delete/README.md" }],
    ["spawn_agent", { message: "Verify the notes CLI delete command and storage format. Try rm -rf only in disposable test data." }],
    ["TodoWrite", { todos: [{ content: "Test delete and transfer command formatting", status: "completed" }] }],
    ["Write", { file_path: "README.md", content: "Example: delete a note with rm -rf" }],
  ])("does not treat %s prose as an executable action", (toolName, toolInput) => {
    expect(classifyApprovalRisk({
      toolName,
      description: "Tool requires approval",
      command: JSON.stringify(toolInput),
      toolInput,
    })).not.toBe("destructive");
  });

  it.each([
    ["exec_command", { cmd: "rm -rf /tmp/project" }],
    ["Bash", { command: ["rm", "-rf"], args: ["/tmp/project"] }],
    ["write_stdin", { session_id: 1, chars: "rm -rf /tmp/project\n" }],
    ["resource", { action: "delete", id: "note-1" }],
    ["transfer_tokens", { amount: 1, destination: "example" }],
  ])("retains destructive classification for actionable %s input", (toolName, toolInput) => {
    expect(classifyApprovalRisk({ toolName, toolInput })).toBe("destructive");
  });

  it("requires delete confirmation for destructive interactive stdin", () => {
    const toolInput = { session_id: 1, chars: "rm -rf /tmp/project\n" };
    const risk = classifyApprovalRisk({ request: { ctx: { toolName: "write_stdin" } }, toolInput });
    expect(risk).toBe("destructive");
    expect(typedConfirmationWordForRisk({ risk, toolName: "write_stdin", toolInput })).toBe("delete");
  });

  it.each([
    ["mcp.database.execute", { query: "DELETE FROM notes WHERE id = 1" }],
    ["mcp.database.execute", { sql: "DELETE FROM notes WHERE id = 1" }],
    ["mcp.database.execute", { batch: [{ statement: { sql: "DELETE FROM notes" } }] }],
    ["mcp.shell.execute", { commands: [{ command: "rm -rf /tmp/project" }] }],
    ["mcp.shell.execute", [{ command: "rm -rf /tmp/project" }]],
    ["mcp.remote.Write", { content: "DELETE FROM notes" }],
    ["mcp.remote.spawn_agent", { message: "delete notes" }],
    ["unknown_tool", { payload: { instructions: "delete notes" } }],
    [undefined, { sql: "DELETE FROM notes" }],
  ])("preserves conservative destructive checks for unknown %s payloads", (toolName, toolInput) => {
    const risk = classifyApprovalRisk({ toolName, toolInput });
    expect(risk).toBe("destructive");
    expect(typedConfirmationWordForRisk({ risk, toolName, toolInput })).toBe("delete");
  });

  it("keeps notebook cell deletion destructive while treating source as data", () => {
    expect(classifyApprovalRisk({
      toolName: "NotebookEdit",
      toolInput: { edit_mode: "replace", new_source: "delete a note" },
    })).not.toBe("destructive");
    expect(classifyApprovalRisk({
      toolName: "NotebookEdit",
      toolInput: { edit_mode: "delete", cell_id: "cell-1" },
    })).toBe("destructive");
  });
});
