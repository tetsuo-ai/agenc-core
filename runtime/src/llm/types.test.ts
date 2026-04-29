import { describe, expect, test } from "vitest";

import { validateToolCallDetailed } from "./types.js";

describe("validateToolCallDetailed", () => {
  test("normalizes plain-string file arguments for readFile", () => {
    const result = validateToolCallDetailed({
      id: "call-1",
      name: "FileRead",
      arguments: "PLAN.MD",
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-1",
      name: "FileRead",
      arguments: JSON.stringify({ file_path: "PLAN.MD" }),
    });
  });

  test("normalizes JSON string bash arguments into the command field", () => {
    const result = validateToolCallDetailed({
      id: "call-2",
      name: "system.bash",
      arguments: JSON.stringify("pwd"),
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2",
      name: "system.bash",
      arguments: JSON.stringify({ command: "pwd" }),
    });
  });

  test("normalizes JSON string exec_command arguments into the cmd field", () => {
    const result = validateToolCallDetailed({
      id: "call-2b",
      name: "exec_command",
      arguments: JSON.stringify("pwd"),
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2b",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    });
  });

  test("normalizes plain string exec_command arguments into the cmd field", () => {
    const result = validateToolCallDetailed({
      id: "call-2c",
      name: "exec_command",
      arguments: "pwd",
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2c",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    });
  });

  test("preserves valid structured exec_command arguments unchanged", () => {
    const result = validateToolCallDetailed({
      id: "call-2d",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2d",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    });
  });

  test("keeps malformed object-like exec_command arguments as empty structured input", () => {
    const result = validateToolCallDetailed({
      id: "call-2e",
      name: "exec_command",
      arguments: '{cd: "/tmp"}',
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2e",
      name: "exec_command",
      arguments: JSON.stringify({}),
    });
  });

  test("does not repair object-shaped bad exec_command args into shell commands", () => {
    const result = validateToolCallDetailed({
      id: "call-2f",
      name: "exec_command",
      arguments: JSON.stringify({ cd: "/tmp" }),
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-2f",
      name: "exec_command",
      arguments: JSON.stringify({ cd: "/tmp" }),
    });
  });

  test("keeps malformed structured file arguments from being rewrapped as a fake path", () => {
    const result = validateToolCallDetailed({
      id: "call-3",
      name: "FileRead",
      arguments: "{}\nPLAN.MD",
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-3",
      name: "FileRead",
      arguments: JSON.stringify({}),
    });
  });

  test("preserves bracket-leading exec_command strings as shell commands", () => {
    const result = validateToolCallDetailed({
      id: "call-4",
      name: "exec_command",
      arguments: "[ -f package.json ] && pwd",
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual({
      id: "call-4",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "[ -f package.json ] && pwd" }),
    });
  });
});
