import { describe, expect, test } from "vitest";

import { validateToolCallDetailed } from "./types.js";

describe("validateToolCallDetailed", () => {
  const entities = "&lt; &gt; &amp; &quot; &#39; &amp;lt;";

  test.each([
    ["exec_command", { cmd: `printf '%s\\n' '${entities}'` }],
    ["system.bash", { command: `printf '%s\\n' '${entities}'` }],
    ["Write", { file_path: "entities.html", content: `<p>${entities}</p>\n` }],
    ["apply_patch", { input: `*** Begin Patch\n*** Add File: entities.html\n+${entities}\n*** End Patch` }],
    ["nested_tool", { items: [entities, { content: entities }], count: 2, enabled: true, empty: null }],
  ])("preserves literal entities in valid %s arguments", (name, args) => {
    const raw = { id: "entities", name, arguments: JSON.stringify(args) };
    const result = validateToolCallDetailed(raw);

    expect(result.failure).toBeUndefined();
    expect(result.toolCall).toEqual(raw);
    expect(JSON.parse(result.toolCall!.arguments)).toEqual(args);
    // Provider parsing, execution validation and history replay may each validate.
    expect(validateToolCallDetailed(result.toolCall).toolCall).toEqual(raw);
  });

  test("preserves valid JSON bytes including whitespace and Unicode escapes", () => {
    const raw = {
      id: "literal-json",
      name: "exec_command",
      arguments: ' \n{ "cmd" : "printf \\\"\\u0026lt;\\\"", "yield_time_ms" : 1e3 }\n',
    };

    expect(validateToolCallDetailed(raw).toolCall).toEqual(raw);
  });

  test.each([false, true])("preserves entities when wrapping a shell string (JSON=%s)", (json) => {
    const command = `printf '%s\\n' '${entities}'`;
    const result = validateToolCallDetailed({
      id: "shell-string",
      name: "exec_command",
      arguments: json ? JSON.stringify(command) : command,
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall?.arguments).toBe(JSON.stringify({ cmd: command }));
  });

  test("repairs the historical Grok escaped JSON syntax case", () => {
    const result = validateToolCallDetailed({
      id: "escaped-json",
      name: "lookup",
      arguments: '{&quot;q&quot;:&quot;hello&quot;}',
    });

    expect(result.failure).toBeUndefined();
    expect(result.toolCall?.arguments).toBe('{"q":"hello"}');
  });

  test("decodes escaped JSON once and preserves entities on subsequent validation", () => {
    const result = validateToolCallDetailed({
      id: "escaped-file",
      name: "Write",
      arguments: '{&quot;file_path&quot;:&quot;entities.html&quot;,&quot;content&quot;:&quot;&amp;lt; &amp;gt; &amp;amp; &amp;quot; &amp;#39; &amp;amp;lt;&quot;}',
    });

    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.toolCall!.arguments)).toEqual({
      file_path: "entities.html",
      content: entities,
    });
    expect(validateToolCallDetailed(result.toolCall).toolCall).toEqual(result.toolCall);
  });

  test.each(["null", "[]", "42", '"&lt;"'])(
    "does not turn valid non-object JSON into tool arguments: %s",
    (argumentsRaw) => {
      const result = validateToolCallDetailed({ id: "non-object", name: "lookup", arguments: argumentsRaw });
      expect(result.toolCall).toBeNull();
      expect(result.failure?.code).toBe("non_object_arguments");
    },
  );

  test("rejects truncated spawn JSON instead of silently replacing it with an empty object", () => {
    const result = validateToolCallDetailed({ id: "spawn", name: "spawn_agent", arguments: '{"message":"unfinished' });
    expect(result.toolCall).toBeNull();
    expect(result.failure?.code).toBe("invalid_json");
  });

  test("preserves literal handoff text and reference delimiters through normalization", () => {
    for (const args of [
      { task_name: "child", message: '  <data>&amp; &quot; 🐈</data>\n' },
      { task_name: "child", message_ref: { source: "current_user_message", after: "&lt;task&gt;", before: "&lt;/task&gt;" } },
    ]) {
      const result = validateToolCallDetailed({ id: "spawn", name: "spawn_agent", arguments: JSON.stringify(args) });
      expect(JSON.parse(result.toolCall!.arguments)).toEqual(args);
    }
  });

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
