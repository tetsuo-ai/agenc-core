import test from "node:test";
import assert from "node:assert/strict";

import { createToolPresentationNormalizer as createNormalizer } from "./fixtures/agenc-watch-tool-presentation-test-helpers.mjs";

test("normalizer classifies desktop editor replace start without transcript copy", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolStart("desktop.text_editor", {
      command: "str_replace",
      filePath: "/tmp/demo.txt",
      old_str: "old value",
      new_str: "new value",
    }),
    {
      kind: "desktop-editor-start",
      command: "str_replace",
      filePathDisplay: "/tmp/demo.txt",
      filePathRaw: "/tmp/demo.txt",
      sourceText: "new value",
      oldText: "old value",
      insertLine: null,
      viewRange: null,
    },
  );
});

test("normalizer parses shell result previews and formatted command fields", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "system.bash",
      {
        command: "npm",
        args: ["run", "test"],
        cwd: "/home/tetsuo/git/AgenC/runtime",
      },
      false,
      JSON.stringify({
        exitCode: 0,
        stdout: "\nall green\nsecond line\n",
        stderr: "",
      }),
    ),
    {
      kind: "shell-result",
      isError: false,
      commandText: "npm run test",
      cwdDisplay: "/home/tetsuo/git/AgenC/runtime",
      exitCode: 0,
      stdoutPreview: "all green",
      stderrPreview: null,
    },
  );
});

test("normalizer suppresses read and search transcript bursts", () => {
  const normalizer = createNormalizer();

  assert.equal(
    normalizer.shouldSuppressToolTranscript("system.readFileRange", {
      path: "PLAN.md",
      startLine: 1,
      endLine: 120,
    }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("system.grep", {
      pattern: "ShellState",
      path: "src",
    }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("system.searchFiles", {
      pattern: "*.c",
      path: "src",
    }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("system.glob", {
      pattern: "**/*.c",
      path: "src",
    }),
    true,
  );
});

test("normalizer keeps generic result parsing separate from final transcript copy", () => {
  const normalizer = createNormalizer();

  const normalized = normalizer.normalizeToolResult(
    "system.inspect",
    { target: "daemon" },
    false,
    '{"status":"ready","detail":"daemon ok"}',
  );

  assert.equal(normalized.kind, "generic-result");
  assert.equal(normalized.toolName, "system.inspect");
  assert.equal(normalized.isError, false);
  assert.deepEqual(normalized.summaryEntries, [{ status: "ready", detail: "daemon ok" }]);
  assert.match(normalized.prettyResult, /"status": "ready"/);
  assert.match(normalized.prettyResult, /"detail": "daemon ok"/);
});

test("normalizer classifies mkdir start and result separately from generic tools", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolStart("system.mkdir", {
      path: "src/ui",
    }),
    {
      kind: "mkdir-start",
      dirPathDisplay: "src/ui",
      dirPathRaw: "src/ui",
    },
  );

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "system.mkdir",
      { path: "src/ui" },
      false,
      '{"path":"src/ui","created":true}',
    ),
    {
      kind: "mkdir-result",
      isError: false,
      dirPathDisplay: "src/ui",
      dirPathRaw: "src/ui",
      errorText: null,
      errorPreview: null,
    },
  );
});

test("normalizer classifies editFile start and result separately from generic tools", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolStart("system.editFile", {
      path: "src/app/args.c",
      old_string: "old value",
      new_string: "new value",
    }),
    {
      kind: "file-edit-start",
      operation: "replace",
      isPlanFile: false,
      filePathDisplay: "src/app/args.c",
      filePathRaw: "src/app/args.c",
      oldText: "old value",
      newText: "new value",
      replaceAll: false,
    },
  );

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "system.editFile",
      {
        path: "src/app/args.c",
        old_string: "old value",
        new_string: "new value",
      },
      false,
      '{"path":"src/app/args.c","replacements":1,"bytesWritten":128}',
    ),
    {
      kind: "file-edit-result",
      isError: false,
      operation: "replace",
      isPlanFile: false,
      filePathDisplay: "src/app/args.c",
      filePathRaw: "src/app/args.c",
      oldText: "old value",
      newText: "new value",
      replaceAll: false,
      replacements: 1,
      bytesWrittenText: "128 B",
      errorText: null,
      errorPreview: null,
    },
  );
});

test("normalizer recognizes OpenClaude-style runtime tool names", () => {
  const normalizer = createNormalizer();

  assert.equal(
    normalizer.shouldSuppressToolTranscript("FileRead", { file_path: "src/app.ts" }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("Grep", { pattern: "TODO", path: "src" }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("Glob", { pattern: "**/*.ts" }),
    true,
  );
  assert.equal(
    normalizer.shouldSuppressToolTranscript("TodoWrite", { todos: [] }),
    true,
  );

  assert.deepEqual(
    normalizer.normalizeToolStart("FileRead", {
      file_path: "src/app.ts",
      offset: 5,
      limit: 3,
    }),
    {
      kind: "file-read-start",
      isPlanFile: false,
      filePathDisplay: "src/app.ts",
      filePathRaw: "src/app.ts",
      fileRange: { startLine: 5, endLine: 7 },
      pages: null,
    },
  );

  assert.deepEqual(
    normalizer.normalizeToolStart("Edit", {
      file_path: "src/new.ts",
      old_string: "",
      new_string: "export const ready = true;\n",
    }),
    {
      kind: "file-edit-start",
      operation: "create",
      isPlanFile: false,
      filePathDisplay: "src/new.ts",
      filePathRaw: "src/new.ts",
      oldText: null,
      newText: "export const ready = true;\n",
      replaceAll: false,
    },
  );
});

test("normalizer classifies plan, verification, search, and disabled external results", () => {
  const normalizer = createNormalizer();

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "Grep",
      { pattern: "ready", path: "src" },
      false,
      JSON.stringify({ filenames: ["src/a.ts", "src/b.ts"] }),
    ),
    {
      kind: "search-result",
      isError: false,
      toolName: "Grep",
      searchKind: "grep",
      pattern: "ready",
      pathDisplay: "src",
      glob: "",
      outputMode: "",
      fileCount: 2,
      matchCount: null,
      lineCount: null,
      outputPreview: "{\"filenames\":[\"src/a.ts\",\"src/b.ts\"]}",
      errorText: null,
    },
  );

  const approvedPlan = normalizer.normalizeToolResult(
    "ExitPlanMode",
    { file_path: ".agenc/plans/demo.md" },
    false,
    JSON.stringify({
      approved: true,
      plan: "# Plan\n- Verify",
      filePath: ".agenc/plans/demo.md",
    }),
  );
  assert.equal(approvedPlan.kind, "plan-exit-result");
  assert.equal(approvedPlan.approved, true);
  assert.equal(approvedPlan.filePathRaw, ".agenc/plans/demo.md");

  const verification = normalizer.normalizeToolResult(
    "spawn_agent",
    { subagent_type: "verification", prompt: "Check test output" },
    false,
    JSON.stringify({ status: "ok", output: "all green" }),
  );
  assert.equal(verification.kind, "delegate-result");
  assert.equal(verification.agentType, "verification");
  assert.equal(verification.agentLabel, "Sentinel");
  assert.equal(verification.status, "ok");

  assert.deepEqual(
    normalizer.normalizeToolResult(
      "WebSearch",
      { query: "release notes" },
      true,
      JSON.stringify({ error: "disabled by no-phone-home mode" }),
    ),
    {
      kind: "external-disabled-result",
      isError: true,
      toolName: "WebSearch",
      surface: "WebSearch",
      target: "release notes",
      reason: "disabled by no-phone-home mode",
    },
  );
});
