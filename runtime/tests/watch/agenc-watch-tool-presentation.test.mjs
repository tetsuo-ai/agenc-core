import test from "node:test";
import assert from "node:assert/strict";

import { createWatchToolPresentation } from "../../src/watch/agenc-watch-tool-presentation.mjs";
import { createToolPresentation } from "./fixtures/agenc-watch-tool-presentation-test-helpers.mjs";

test("createWatchToolPresentation validates required dependencies", () => {
  assert.throws(
    () => createWatchToolPresentation({}),
    /requires a sanitizeInlineText function dependency/,
  );
});

test("tool presentation formats shell starts and low-signal suppression", () => {
  const tools = createToolPresentation();

  assert.equal(
    tools.shouldSuppressToolTranscript("system.bash", { command: "pwd" }),
    true,
  );
  assert.equal(
    tools.backgroundToolSurfaceLabel("system.bash", { command: "npm", args: ["test"] }),
    "Run npm test",
  );

  assert.deepEqual(
    tools.describeToolStart("system.bash", {
      command: "npm",
      args: ["run", "test"],
      cwd: "/home/tetsuo/git/AgenC/runtime",
    }),
    {
      title: "Run npm run test",
      body: "cwd: /home/tetsuo/git/AgenC/runtime",
      tone: "yellow",
    },
  );
});

test("tool presentation formats delegated child tasks", () => {
  const tools = createToolPresentation();

  const descriptor = tools.describeToolStart("execute_with_agent", {
    objective: "Implement the DAG renderer",
    tools: ["system.bash", "system.writeFile"],
    workingDirectory: "/home/tetsuo/git/AgenC/runtime",
    acceptanceCriteria: ["tests pass", "build succeeds"],
  });

  assert.equal(descriptor.title, "Delegate Implement the DAG renderer");
  assert.match(descriptor.body, /tools: system.bash, system.writeFile/);
  assert.match(descriptor.body, /cwd: \/home\/tetsuo\/git\/AgenC\/runtime/);
  assert.match(descriptor.body, /acceptance: tests pass \| build succeeds/);
  assert.equal(descriptor.tone, "magenta");
});

test("tool presentation formats text-editor reads and suppresses low-signal reads", () => {
  const tools = createToolPresentation();

  assert.equal(
    tools.shouldSuppressToolTranscript("system.readFileRange", {
      path: "/tmp/demo.txt",
      startLine: 1,
      endLine: 40,
    }),
    true,
  );
  assert.equal(
    tools.shouldSuppressToolTranscript("system.grep", {
      pattern: "ShellState",
      path: "src",
    }),
    true,
  );
  assert.equal(
    tools.shouldSuppressToolTranscript("system.searchFiles", {
      path: "src",
      pattern: "*.c",
    }),
    true,
  );
  assert.equal(
    tools.shouldSuppressToolTranscript("desktop.text_editor", {
      command: "view",
      filePath: "/tmp/demo.txt",
      view_range: [1, 20],
    }),
    true,
  );

  assert.deepEqual(
    tools.describeToolResult(
      "desktop.text_editor",
      {
        command: "view",
        filePath: "/tmp/demo.txt",
      },
      false,
      JSON.stringify({ output: "line one\nline two" }),
    ),
    {
      title: "Read /tmp/demo.txt",
      body: "path: /tmp/demo.txt\nline one\nline two",
      tone: "slate",
      previewMode: "source-read",
      filePath: "/tmp/demo.txt",
    },
  );
});

test("tool presentation emits structured mutation metadata for write and replace flows", () => {
  const tools = createToolPresentation();

  const writeDescriptor = tools.describeToolStart("system.writeFile", {
    path: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
    content: "export const ready = true;\n",
  });
  assert.equal(writeDescriptor.previewMode, "source-write");
  assert.equal(writeDescriptor.filePath, "/home/tetsuo/git/AgenC/runtime/src/index.ts");
  assert.equal(writeDescriptor.mutationKind, "write");
  assert.equal(writeDescriptor.mutationAfterText, "export const ready = true;\n");
  assert.equal(writeDescriptor.title, "Write /home/tetsuo/git/AgenC/runtime/src/index.ts");
  assert.equal(
    writeDescriptor.body,
    "path: /home/tetsuo/git/AgenC/runtime/src/index.ts\nlines: 1\nexport const ready = true;\n",
  );

  const replaceDescriptor = tools.describeToolStart("desktop.text_editor", {
    command: "str_replace",
    filePath: "/tmp/demo.txt",
    old_str: "old value",
    new_str: "new value",
  });
  assert.equal(replaceDescriptor.previewMode, "source-write");
  assert.equal(replaceDescriptor.filePath, "/tmp/demo.txt");
  assert.equal(replaceDescriptor.mutationKind, "replace");
  assert.equal(replaceDescriptor.mutationBeforeText, "old value");
  assert.equal(replaceDescriptor.mutationAfterText, "new value");
});

test("tool presentation formats shell results and generic summaries", () => {
  const tools = createToolPresentation();

  assert.deepEqual(
    tools.describeToolResult(
      "system.bash",
      {
        command: "pwd",
        cwd: "/home/tetsuo/git/AgenC",
      },
      false,
      JSON.stringify({ exitCode: 0, stdout: "/home/tetsuo/git/AgenC\n" }),
    ),
    {
      title: "Ran pwd",
      body: "exit 0 · /home/tetsuo/git/AgenC",
      tone: "green",
    },
  );

  const generic = tools.describeToolResult(
    "system.inspect",
    { target: "daemon" },
    false,
    JSON.stringify({ status: "ready" }),
  );

  assert.equal(generic.title, "system.inspect");
  assert.equal(generic.body, "status: ready");
  assert.equal(generic.tone, "green");
});

test("tool presentation gives system.mkdir a tool-specific row and terse success body", () => {
  const tools = createToolPresentation();

  assert.deepEqual(
    tools.describeToolStart("system.mkdir", {
      path: "src/ui",
    }),
    {
      title: "mkdir src/ui",
      body: "path: src/ui",
      tone: "yellow",
    },
  );

  assert.deepEqual(
    tools.describeToolResult(
      "system.mkdir",
      { path: "src/ui" },
      false,
      JSON.stringify({ path: "src/ui", created: true }),
    ),
    {
      title: "mkdir src/ui",
      body: "Done",
      tone: "green",
    },
  );
});

test("tool presentation keeps file writes concise instead of embedding full payload bodies", () => {
  const tools = createToolPresentation();
  const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

  const start = tools.describeToolStart("system.writeFile", {
    path: "src/app/main.c",
    content,
  });
  assert.equal(start.title, "Write src/app/main.c");
  assert.equal(start.previewMode, "source-write");
  assert.equal(start.filePath, "src/app/main.c");
  assert.equal(start.mutationAfterText, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
  assert.match(start.body, /^path: src\/app\/main\.c\nlines: 12\nline 1/);
  assert.doesNotMatch(start.body, /line 11/);

  const result = tools.describeToolResult(
    "system.writeFile",
    {
      path: "src/app/main.c",
      content,
    },
    false,
    JSON.stringify({ path: "src/app/main.c", bytesWritten: 128 }),
  );
  assert.equal(result.title, "Wrote src/app/main.c");
  assert.match(result.body, /^path: src\/app\/main\.c\nlines: 12\nwritten: 128 B\nline 1/);
  assert.doesNotMatch(result.body, /line 11/);
});

test("tool presentation gives system.editFile a source-style path row and terse error body", () => {
  const tools = createToolPresentation();

  assert.deepEqual(
    tools.describeToolStart("system.editFile", {
      path: "src/app/args.c",
      old_string: "old value",
      new_string: "new value",
    }),
    {
      title: "Update src/app/args.c",
      body: "src/app/args.c",
      tone: "yellow",
      previewMode: "source-write",
      filePath: "src/app/args.c",
      mutationKind: "replace",
      mutationBeforeText: "old value",
      mutationAfterText: "new value",
    },
  );

  assert.deepEqual(
    tools.describeToolResult(
      "system.editFile",
      {
        path: "src/app/args.c",
        old_string: "old value",
        new_string: "new value",
      },
      true,
      JSON.stringify({
        error:
          "old_string not found in src/app/args.c. The exact text you provided does not appear anywhere in the file after quote/desanitization normalization.",
      }),
    ),
    {
      title: "Update src/app/args.c",
      body: "Error editing file",
      tone: "red",
      previewMode: "source-write",
      filePath: "src/app/args.c",
      mutationKind: "replace",
      mutationBeforeText: "old value",
      mutationAfterText: "new value",
    },
  );
});
