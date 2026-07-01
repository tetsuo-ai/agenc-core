import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceUrl } from "../helpers/source-path.ts";

import type { ToolUseContext } from "./Tool.js";
import { applyToolApprovalConfigToPermissionContext } from "../permissions/tool-approval.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  CanonicalBashTool,
  CanonicalFileEditTool,
  CanonicalFileReadTool,
  CanonicalFileWriteTool,
  CanonicalGlobTool,
  CanonicalGrepTool,
  CanonicalNotebookEditTool,
} from "./canonicalToolSurface.js";
import { createBashTool } from "./system/bash.js";
import {
  clearFileReadListenersForTests,
  registerFileReadListener,
} from "./system/file-read.js";
import {
  clearSessionReadState,
  SESSION_ID_ARG,
} from "./system/filesystem.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../tools/ScheduleCronTool/CronCreateTool.js", () => ({
  CronCreateTool: { name: "schedule_cron.create" },
}));
vi.mock("../tools/ScheduleCronTool/CronDeleteTool.js", () => ({
  CronDeleteTool: { name: "schedule_cron.delete" },
}));
vi.mock("../tools/ScheduleCronTool/CronListTool.js", () => ({
  CronListTool: { name: "schedule_cron.list" },
}));
vi.mock("../commands.js", () => ({
  getSkillToolCommands: vi.fn(() => []),
  getMcpSkillCommands: vi.fn(() => []),
}));
vi.mock("../tools.js", () => ({
  getTools: vi.fn(() => []),
  getAllBaseTools: vi.fn(() => []),
  assembleToolPool: vi.fn(() => []),
  getToolsForDefaultPreset: vi.fn(() => []),
  parseToolPreset: vi.fn(() => []),
  ALL_AGENT_DISALLOWED_TOOLS: [],
}));

function toolContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => ({
      toolPermissionContext: createEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext;
}

function attachmentContext(readFileState = new Map()): ToolUseContext {
  return {
    ...toolContext(),
    readFileState,
  } as unknown as ToolUseContext;
}

async function withMockedCanonicalFileRead<T>(
  call: typeof CanonicalFileReadTool.call,
  run: () => Promise<T>,
): Promise<T> {
  const original = CanonicalFileReadTool.call;
  CanonicalFileReadTool.call = call;
  try {
    return await run();
  } finally {
    CanonicalFileReadTool.call = original;
  }
}

function resultText(data: unknown): string {
  return data && typeof data === "object" && "content" in data
    ? String((data as { readonly content?: unknown }).content ?? "")
    : String(data ?? "");
}

describe("old-stack tool surface consolidation", () => {
  test("base tools register canonical implementations for duplicated families", () => {
    const source = readFileSync(sourceUrl("tools.ts"), "utf8");

    expect(source).toContain("CanonicalBashTool");
    expect(source).toContain("CanonicalFileReadTool");
    expect(source).toContain("CanonicalFileEditTool");
    expect(source).toContain("CanonicalFileWriteTool");
    expect(source).toContain("CanonicalGlobTool");
    expect(source).toContain("CanonicalGrepTool");
    expect(source).toContain("CanonicalNotebookEditTool");
    expect(source).not.toMatch(
      /tools\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\.js/,
    );
  });

  test("REPL primitive tools use the canonical search and file surfaces", () => {
    const source = readFileSync(
      sourceUrl("tools/REPLTool/primitiveTools.ts"),
      "utf8",
    );

    expect(source).toContain("CanonicalBashTool");
    expect(source).toContain("CanonicalFileReadTool");
    expect(source).toContain("CanonicalFileEditTool");
    expect(source).toContain("CanonicalFileWriteTool");
    expect(source).toContain("CanonicalGlobTool");
    expect(source).toContain("CanonicalGrepTool");
    expect(source).toContain("CanonicalNotebookEditTool");
    expect(source).not.toMatch(
      /tools\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\.js/,
    );
  });

  test("system.bash enforces command-specific permission rules", async () => {
    const permissionContext = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        deny: ["system.bash(git *)"],
        ask: ["system.bash(npm --version)"],
        allow: ["system.bash(echo *)"],
      },
    );
    const context = {
      getAppState: () => ({ toolPermissionContext: permissionContext }),
    } as never;
    const tool = createBashTool();

    await expect(tool.checkPermissions?.({ command: "git status" }, context))
      .resolves.toMatchObject({ behavior: "deny" });
    await expect(tool.checkPermissions?.({ command: "npm --version" }, context))
      .resolves.toMatchObject({ behavior: "ask" });
    await expect(tool.checkPermissions?.({ command: "echo ok" }, context))
      .resolves.toMatchObject({ behavior: "allow" });
  });

  test("system.bash honors legacy Bash permission aliases with precedence", async () => {
    const permissionContext = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        deny: ["Bash(git:*)"],
        ask: ["Bash(npm --version)"],
        allow: ["Bash(echo:*)"],
      },
    );
    const context = {
      getAppState: () => ({ toolPermissionContext: permissionContext }),
    } as never;
    const tool = createBashTool();

    await expect(tool.checkPermissions?.({ command: "git status" }, context))
      .resolves.toMatchObject({ behavior: "deny" });
    await expect(tool.checkPermissions?.({ command: "npm --version" }, context))
      .resolves.toMatchObject({ behavior: "ask" });
    await expect(tool.checkPermissions?.({ command: "echo ok" }, context))
      .resolves.toMatchObject({ behavior: "allow" });

    const denyWinsContext = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        deny: ["Bash(node:*)"],
        ask: ["system.bash(node:*)"],
        allow: ["system.bash(node:*)"],
      },
    );
    await expect(
      tool.checkPermissions?.(
        { command: "node --version" },
        { getAppState: () => ({ toolPermissionContext: denyWinsContext }) } as never,
      ),
    ).resolves.toMatchObject({ behavior: "deny" });

    const askWinsContext = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        ask: ["Bash(printf:*)"],
        allow: ["system.bash(printf:*)"],
      },
    );
    await expect(
      tool.checkPermissions?.(
        { command: "printf hello" },
        { getAppState: () => ({ toolPermissionContext: askWinsContext }) } as never,
      ),
    ).resolves.toMatchObject({ behavior: "ask" });

    const wholeToolDenyContext = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { deny: ["Bash"] },
    );
    await expect(
      tool.checkPermissions?.(
        { command: "echo blocked" },
        { getAppState: () => ({ toolPermissionContext: wholeToolDenyContext }) } as never,
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  test("canonical Bash schema rejects unsupported legacy control fields", () => {
    expect(() =>
      CanonicalBashTool.inputSchema.parse({
        command: "echo ok",
        dangerouslyDisableSandbox: true,
      }),
    ).toThrow();
    expect(() =>
      CanonicalBashTool.inputSchema.parse({
        command: "echo ok",
        run_in_background: true,
      }),
    ).toThrow();
  });

  test("canonical Bash and daemon system.bash share execution behavior", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-bash-"));
    try {
      const input = {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: workspace,
      };
      const canonical = await CanonicalBashTool.call(
        input,
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const daemon = await createBashTool({ cwd: workspace }).execute(input);

      expect(resultText(canonical.data)).toContain(workspace);
      expect(daemon.content).toContain(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical Bash failure marks tool_result as error", async () => {
    const result = await CanonicalBashTool.call(
      { command: "false" },
      toolContext(),
      (async () => undefined) as never,
      {} as never,
    );
    const block = CanonicalBashTool.mapToolResultToToolResultBlockParam(
      result.data,
      "tool-error",
    );

    expect(block.is_error).toBe(true);
  });

  test("canonical Bash wrapper forwards system Bash progress updates", async () => {
    const progressEvents: unknown[] = [];

    await CanonicalBashTool.call(
      { command: "printf first; sleep 0.05; printf second" },
      toolContext(),
      (async () => undefined) as never,
      {} as never,
      ((event: unknown) => {
        progressEvents.push(event);
      }) as never,
    );

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(progressEvents)).toContain("bash_progress");
    expect(JSON.stringify(progressEvents)).toContain("first");
  });

  test("canonical Bash truncates large output without persisted-output recovery", async () => {
    const { processToolResultBlock } = await import("../utils/toolResultStorage.js");
    const result = await CanonicalBashTool.call(
      {
        command: `${process.execPath} -e "process.stdout.write('x'.repeat(120000))"`,
      },
      toolContext(),
      (async () => undefined) as never,
      {} as never,
    );

    expect(resultText(result.data)).toContain("[truncated]");
    expect(result.data).toMatchObject({
      metadata: expect.objectContaining({ truncated: true }),
    });
    const block = await processToolResultBlock(
      CanonicalBashTool,
      result.data,
      "large-canonical-bash",
    );
    expect(String(block.content)).toContain("[truncated]");
    expect(String(block.content)).not.toContain("<persisted-output>");
  });

  test("canonical wrappers preserve search/read classification hooks", () => {
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "ls src" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: true });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat package.json|jq .name" }),
    ).toMatchObject({ isSearch: false, isRead: true, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat script.sh|sh" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat package.json&sh" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat package.json\nsh" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat package.json$(sh)" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat package.json`sh`" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalBashTool.isSearchOrReadCommand?.({ command: "cat >(sh)" }),
    ).toMatchObject({ isSearch: false, isRead: false, isList: false });
    expect(
      CanonicalFileReadTool.isSearchOrReadCommand?.({ file_path: "package.json" }),
    ).toMatchObject({ isSearch: false, isRead: true });
    expect(
      CanonicalGrepTool.isSearchOrReadCommand?.({ pattern: "needle" }),
    ).toMatchObject({ isSearch: true, isRead: false });
    expect(
      CanonicalGlobTool.isSearchOrReadCommand?.({ pattern: "*.ts" }),
    ).toMatchObject({ isSearch: true, isRead: false });
  });

  test("canonical FileRead schema accepts numeric string ranges", () => {
    expect(
      CanonicalFileReadTool.inputSchema.safeParse({
        file_path: "package.json",
        offset: "2",
        limit: "10",
      }).success,
    ).toBe(true);
    expect(
      CanonicalFileReadTool.inputSchema.safeParse({
        file_path: "package.json",
        offset: "abc",
      }).success,
    ).toBe(false);
  });

  test("canonical file wrappers enforce session read-before-edit", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-file-"));
    const sessionId = "canonical-file-session";
    const unreadSessionId = "canonical-file-unread-session";
    try {
      const filePath = join(workspace, "demo.txt");
      await writeFile(filePath, "old", "utf8");

      const unreadEdit = await CanonicalFileEditTool.call(
        {
          file_path: filePath,
          old_string: "old",
          new_string: "bad",
          [SESSION_ID_ARG]: unreadSessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      expect(unreadEdit.data).toMatchObject({ isError: true });
      expect(resultText(unreadEdit.data)).toContain("File has not been read yet");

      await CanonicalFileReadTool.call(
        { file_path: filePath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      await CanonicalFileEditTool.call(
        {
          file_path: filePath,
          old_string: "old",
          new_string: "new",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      await expect(readFile(filePath, "utf8")).resolves.toBe("new");
    } finally {
      clearSessionReadState(sessionId);
      clearSessionReadState(unreadSessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("file attachments read through canonical FileRead implementation", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-attachment-"));
    const filePath = join(workspace, "demo.txt");
    const observedReads: string[] = [];
    const unregister = registerFileReadListener((event) => {
      observedReads.push(event.filePath);
    });
    try {
      const { generateFileAttachment } = await import("../utils/attachments.js");
      await writeFile(filePath, "attachment text\n", "utf8");
      const attachment = await generateFileAttachment(
        filePath,
        {
          abortController: new AbortController(),
          getAppState: () => ({
            toolPermissionContext: createEmptyToolPermissionContext(),
          }),
          readFileState: new Map(),
          nestedMemoryAttachmentTriggers: new Set(),
          options: {},
        } as never,
        "attachment_success",
        "attachment_error",
        "at-mention",
      );

      expect(attachment?.type).toBe("file");
      expect(resultText((attachment as { content?: unknown })?.content))
        .toContain("attachment text");
      expect(observedReads).toContain(filePath);
    } finally {
      unregister();
      clearFileReadListenersForTests();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("directory attachments render through canonical Bash implementation", async () => {
    const { normalizeAttachmentForAPI } = await import("../utils/messages.js");
    const messages = normalizeAttachmentForAPI({
      type: "directory",
      path: "/tmp/example",
      content: "demo.txt\n",
    } as never);
    const rendered = JSON.stringify(messages);

    expect(rendered).toContain("Called the system.bash tool");
    expect(rendered).toContain("Result of calling the system.bash tool");
    expect(rendered).toContain("demo.txt");
  });

  test("canonical NotebookEdit uses shared session-backed implementation", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-notebook-"));
    const sessionId = "canonical-notebook-session";
    const unreadSessionId = "canonical-notebook-unread-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              id: "cell-a",
              metadata: {},
              source: "print('old')",
              execution_count: 1,
              outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
            },
          ],
          metadata: { language_info: { name: "python" } },
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      const unreadEdit = await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "cell-a",
          new_source: "print('bad')",
          [SESSION_ID_ARG]: unreadSessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      expect(unreadEdit.data).toMatchObject({ isError: true });
      expect(resultText(unreadEdit.data)).toContain("File has not been read yet");

      await CanonicalFileReadTool.call(
        { file_path: notebookPath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "cell-a",
          new_source: "print('new')",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells[0].source).toBe("print('new')");
      expect(updated.cells[0].execution_count).toBeNull();
      expect(updated.cells[0].outputs).toEqual([]);
    } finally {
      clearSessionReadState(sessionId);
      clearSessionReadState(unreadSessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical NotebookEdit prefers exact numeric cell IDs over index fallback", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-notebook-id-"));
    const sessionId = "canonical-notebook-numeric-id-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "markdown",
              id: "intro",
              metadata: {},
              source: "intro",
            },
            {
              cell_type: "markdown",
              id: "0",
              metadata: {},
              source: "numeric id",
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      await CanonicalFileReadTool.call(
        { file_path: notebookPath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const result = await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "0",
          new_source: "updated numeric id",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells.map((cell: Record<string, unknown>) => cell.source))
        .toEqual(["intro", "updated numeric id"]);
      expect(resultText(result.data)).toContain('"cell_type":"markdown"');
      expect(resultText(result.data)).toContain('"language":"python"');
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical NotebookEdit defaults sparse metadata language to python", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-notebook-language-"));
    const sessionId = "canonical-notebook-language-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              id: "cell-a",
              metadata: {},
              source: "print('old')",
              execution_count: null,
              outputs: [],
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      await CanonicalFileReadTool.call(
        { file_path: notebookPath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const result = await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "cell-a",
          new_source: "print('new')",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      expect(resultText(result.data)).toContain('"language":"python"');
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical NotebookEdit defaults empty metadata language to python", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-notebook-empty-language-"));
    const sessionId = "canonical-notebook-empty-language-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              id: "cell-a",
              metadata: {},
              source: "print('old')",
              execution_count: null,
              outputs: [],
            },
          ],
          metadata: { language_info: { name: "" } },
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      await CanonicalFileReadTool.call(
        { file_path: notebookPath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const result = await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "cell-a",
          new_source: "print('new')",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      expect(resultText(result.data)).toContain('"language":"python"');
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical NotebookEdit delete does not require new_source", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-notebook-delete-"));
    const sessionId = "canonical-notebook-delete-session";
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "markdown",
              id: "keep",
              metadata: {},
              source: "keep",
            },
            {
              cell_type: "code",
              id: "delete-me",
              metadata: {},
              source: "print('delete')",
              execution_count: 1,
              outputs: [],
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      await CanonicalFileReadTool.call(
        { file_path: notebookPath, [SESSION_ID_ARG]: sessionId },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const result = await CanonicalNotebookEditTool.call(
        {
          notebook_path: notebookPath,
          cell_id: "delete-me",
          edit_mode: "delete",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells.map((cell: Record<string, unknown>) => cell.id))
        .toEqual(["keep"]);
      expect(resultText(result.data)).toContain('"edit_mode":"delete"');
      expect(resultText(result.data)).not.toContain('"new_source"');
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical Write, Grep, and Glob wrappers execute shared system tools", async () => {
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-canonical-search-"));
    const sessionId = "canonical-write-search-session";
    try {
      const filePath = join(workspace, "demo.txt");
      await CanonicalFileWriteTool.call(
        {
          file_path: filePath,
          content: "needle\n",
          [SESSION_ID_ARG]: sessionId,
        },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      const grep = await CanonicalGrepTool.call(
        { pattern: "needle", path: workspace },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );
      const glob = await CanonicalGlobTool.call(
        { pattern: "*.txt", path: workspace },
        toolContext(),
        (async () => undefined) as never,
        {} as never,
      );

      expect(resultText(grep.data)).toContain("demo.txt");
      expect(resultText(glob.data)).toContain("demo.txt");
    } finally {
      clearSessionReadState(sessionId);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("canonical result mapping preserves rich contentItems", () => {
    const block = CanonicalFileReadTool.mapToolResultToToolResultBlockParam(
      {
        content: "fallback",
        contentItems: [
          { type: "input_text", text: "image follows" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,YWJj",
          },
        ],
      },
      "tool-1",
    );

    expect(block.content).toEqual([
      { type: "text", text: "image follows" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "YWJj",
        },
      },
    ]);
  });

  test("legacy tool aliases resolve to canonical agent tools", async () => {
    const { resolveAgentTools } = await import("./AgentTool/agentToolUtils.js");
    const availableTools = [
      CanonicalBashTool,
      CanonicalFileReadTool,
      CanonicalFileEditTool,
      CanonicalFileWriteTool,
    ];

    const resolved = resolveAgentTools(
      {
        source: "built-in",
        tools: ["Bash", "Read", "FileEdit", "FileWrite"],
      } as never,
      availableTools as never,
      false,
      true,
    );

    expect(resolved.invalidTools).toEqual([]);
    expect(resolved.resolvedTools.map((tool) => tool.name)).toEqual([
      "system.bash",
      "FileRead",
      "Edit",
      "Write",
    ]);

    const filtered = resolveAgentTools(
      {
        source: "built-in",
        tools: ["*"],
        disallowedTools: ["Read", "FileEdit"],
      } as never,
      availableTools as never,
      false,
      true,
    );

    expect(filtered.resolvedTools.map((tool) => tool.name)).toEqual([
      "system.bash",
      "Write",
    ]);
  });

  test("file attachments truncate after canonical FileRead size errors", async () => {
    const { generateFileAttachment } = await import("../utils/attachments.js");
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-attachment-size-"));
    try {
      const filePath = join(workspace, "large.txt");
      await writeFile(filePath, "content\n", "utf8");
      const calls: Record<string, unknown>[] = [];

      const result = await withMockedCanonicalFileRead(
        (async (input: Record<string, unknown>) => {
          calls.push(input);
          if (calls.length === 1) {
            return {
              data: {
                content:
                  "File content (100000 tokens) exceeds maximum allowed tokens (25000).",
                isError: true,
              },
            };
          }
          return { data: "truncated content" };
        }) as typeof CanonicalFileReadTool.call,
        () =>
          generateFileAttachment(
            filePath,
            attachmentContext(),
            "attachment_success",
            "attachment_error",
            "at-mention",
          ),
      );

      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ limit: expect.any(Number) });
      expect(result).toMatchObject({
        type: "file",
        filename: filePath,
        content: "truncated content",
        truncated: true,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("file attachments return null after canonical FileRead non-size errors", async () => {
    const { generateFileAttachment } = await import("../utils/attachments.js");
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-attachment-error-"));
    try {
      const filePath = join(workspace, "denied.txt");
      await writeFile(filePath, "content\n", "utf8");

      const result = await withMockedCanonicalFileRead(
        (async () => ({
          data: {
            content: "Permission denied",
            isError: true,
          },
        })) as typeof CanonicalFileReadTool.call,
        () =>
          generateFileAttachment(
            filePath,
            attachmentContext(),
            "attachment_success",
            "attachment_error",
            "at-mention",
          ),
      );

      expect(result).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("changed-file attachments stop after canonical FileRead errors", async () => {
    const { getChangedFiles } = await import("../utils/attachments.js");
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-attachment-changed-"));
    try {
      const filePath = join(workspace, "changed.txt");
      await writeFile(filePath, "new\n", "utf8");
      const readFileState = new Map([
        [
          filePath,
          {
            content: "old\n",
            timestamp: 0,
            offset: undefined,
            limit: undefined,
          },
        ],
      ]);

      const result = await withMockedCanonicalFileRead(
        (async () => ({
          data: {
            content:
              "File content (100000 tokens) exceeds maximum allowed tokens (25000).",
            isError: true,
          },
        })) as typeof CanonicalFileReadTool.call,
        () => getChangedFiles(attachmentContext(readFileState)),
      );

      expect(result).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("changed-file attachments skip canonical notebook and PDF media", async () => {
    const { getChangedFiles } = await import("../utils/attachments.js");
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-attachment-media-"));
    try {
      const cases = [
        {
          filename: "doc.pdf",
          data: {
            content: "pdf text",
            metadata: { mediaType: "application/pdf" },
          },
        },
        {
          filename: "notebook.ipynb",
          data: {
            content: "notebook text",
            metadata: { mediaType: "application/x-ipynb+json" },
          },
        },
        {
          filename: "notebook-with-image.ipynb",
          data: {
            content: "notebook text",
            contentItems: [
              { type: "input_text", text: "notebook text" },
              { type: "input_image", image_url: "data:image/png;base64,YWJj" },
            ],
            metadata: { mediaType: "application/x-ipynb+json" },
          },
        },
      ];

      for (const entry of cases) {
        const filePath = join(workspace, entry.filename);
        await writeFile(filePath, "new\n", "utf8");
        const readFileState = new Map([
          [
            filePath,
            {
              content: "old\n",
              timestamp: 0,
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);

        const result = await withMockedCanonicalFileRead(
          (async () => ({ data: entry.data })) as typeof CanonicalFileReadTool.call,
          () => getChangedFiles(attachmentContext(readFileState)),
        );

        expect(result).toEqual([]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("changed-file attachments preserve standalone canonical image media", async () => {
    const { getChangedFiles } = await import("../utils/attachments.js");
    const workspace = await mkdtemp(join(process.cwd(), ".tmp-attachment-image-"));
    try {
      const filePath = join(workspace, "image.png");
      await writeFile(filePath, "new\n", "utf8");
      const imageData = {
        content: "Read image",
        contentItems: [
          { type: "input_text", text: "Read image" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
        metadata: { mediaType: "image/png" },
      };
      const readFileState = new Map([
        [
          filePath,
          {
            content: "old\n",
            timestamp: 0,
            offset: undefined,
            limit: undefined,
          },
        ],
      ]);

      const result = await withMockedCanonicalFileRead(
        (async () => ({ data: imageData })) as typeof CanonicalFileReadTool.call,
        () => getChangedFiles(attachmentContext(readFileState)),
      );

      expect(result).toEqual([
        {
          type: "edited_image_file",
          filename: filePath,
          content: imageData,
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
