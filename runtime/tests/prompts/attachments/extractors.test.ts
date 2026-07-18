import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createUserMessage, createAssistantMessage } from "../../../src/utils/messages.js";
import type { ToolUseContext } from "../../../src/tools/Tool.js";
import { runWithCurrentRuntimeSession } from "../../../src/session/current-session.js";
import type { Session } from "../../../src/session/session.js";
import { createTask, getTaskListId } from "../../../src/utils/tasks.js";
import { CanonicalFileReadTool } from "../../../src/tools/canonicalToolSurface.js";
import { applyPermissionRulesToPermissionContext } from "../../../src/permissions/rules.js";
import {
  createEmptyToolPermissionContext,
  type PermissionRule,
  type ToolPermissionContext,
} from "../../../src/permissions/types.js";
import {
  setLastEmittedDate,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from "../../../src/bootstrap/state.js";
import {
  collectRecentSuccessfulTools,
  collectSurfacedMemories,
  createAttachmentMessage,
  extractAgentMentions,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  filterDuplicateMemoryAttachments,
  filterToBundledAndMcp,
  generateFileAttachment,
  getAttachments,
  getAttachmentMessages,
  getChangedFiles,
  getDateChangeAttachments,
  getDirectoriesToProcess,
  getQueuedCommandAttachments,
  getVerifyPlanReminderTurnCount,
  memoryFilesToAttachments,
  memoryHeader,
  parseAtMentionedFileLines,
  tryGetPDFReference,
} from "../../../src/utils/attachments.js";

const originalDisableAttachments = process.env.AGENC_DISABLE_ATTACHMENTS;
const originalSimpleMode = process.env.AGENC_SIMPLE;
const originalEnableTasks = process.env.AGENC_ENABLE_TASKS;
const originalTaskListId = process.env.AGENC_TASK_LIST_ID;
const originalConfigDir = process.env.AGENC_CONFIG_DIR;
const originalUserType = process.env.USER_TYPE;

function toolUse(id: string, name = "Bash") {
  return {
    type: "tool_use",
    id,
    name,
    input: { command: "echo ok" },
  } as const;
}

function toolResult(id: string, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: isError ? "failed" : "ok",
    is_error: isError,
  } as const;
}

function attachmentContext(
  readFileState = new Map<string, unknown>(),
  toolPermissionContext: ToolPermissionContext = createEmptyToolPermissionContext(),
  optionOverrides: Partial<ToolUseContext["options"]> = {},
  appStateOverrides: Record<string, unknown> = {},
): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState,
    nestedMemoryAttachmentTriggers: new Set(),
    options: {
      commands: [],
      debug: false,
      tools: [],
      verbose: false,
      mainLoopModel: "gpt-test",
      mcpClients: [],
      mcpResources: {},
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      ...optionOverrides,
    },
    getAppState: () => ({
      toolPermissionContext,
      todos: {},
      ...appStateOverrides,
    }),
  } as unknown as ToolUseContext;
}

function withUnadmittedTestSession<T>(run: () => T): T {
  return runWithCurrentRuntimeSession(
    {
      conversationId: "attachment-extractors",
      services: { admissionRequired: false },
    } as unknown as Session,
    run,
  );
}

async function collectAsyncGenerator<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const result of generator) {
    results.push(result);
  }
  return results;
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreOptionalEnv("AGENC_DISABLE_ATTACHMENTS", originalDisableAttachments);
  restoreOptionalEnv("AGENC_SIMPLE", originalSimpleMode);
  restoreOptionalEnv("AGENC_ENABLE_TASKS", originalEnableTasks);
  restoreOptionalEnv("AGENC_TASK_LIST_ID", originalTaskListId);
  restoreOptionalEnv("AGENC_CONFIG_DIR", originalConfigDir);
  restoreOptionalEnv("USER_TYPE", originalUserType);
  setLastEmittedDate(null);
  setHasExitedPlanMode(false);
  setNeedsPlanModeExitAttachment(false);
  setNeedsAutoModeExitAttachment(false);
});

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

async function withTempWorkspace<T>(
  prefix: string,
  run: (workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("attachment mention extractors", () => {
  describe("getAttachments aggregation", () => {
    test("returns queued commands when attachments are disabled", async () => {
      process.env.AGENC_DISABLE_ATTACHMENTS = "1";

      const attachments = await getAttachments(
        "ignored while disabled",
        attachmentContext(),
        null,
        [
          {
            mode: "prompt",
            value: "queued prompt",
            uuid: "cmd-disabled-1",
            origin: { kind: "human" },
          },
          {
            mode: "bash",
            value: "echo skipped",
            uuid: "cmd-disabled-2",
          },
        ] as never,
      );

      expect(attachments).toEqual([
        expect.objectContaining({
          type: "queued_command",
          prompt: "queued prompt",
          source_uuid: "cmd-disabled-1",
        }),
      ]);
    });

    test("wraps generated attachments as attachment messages", async () => {
      process.env.AGENC_DISABLE_ATTACHMENTS = "1";

      const messages = await collectAsyncGenerator(
        getAttachmentMessages(
          "ignored while disabled",
          attachmentContext(),
          null,
          [
            {
              mode: "prompt",
              value: "queued prompt",
              uuid: "cmd-generator-1",
              origin: { kind: "human" },
            },
          ] as never,
        ),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "attachment",
        attachment: {
          type: "queued_command",
          prompt: "queued prompt",
          source_uuid: "cmd-generator-1",
        },
      });

      await expect(
        collectAsyncGenerator(
          getAttachmentMessages(null, attachmentContext(), null, []),
        ),
      ).resolves.toEqual([]);
    });

    test("adds plan-mode reminders on first plan turn and throttles recent reminders", async () => {
      const planContext = attachmentContext(
        new Map(),
        createEmptyToolPermissionContext({ mode: "plan" }),
      );

      const firstTurn = await getAttachments(null, planContext, null, [], []);
      expect(firstTurn).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "plan_mode",
            reminderType: "full",
            isSubAgent: false,
            planExists: false,
          }),
        ]),
      );

      const throttled = await getAttachments(
        null,
        planContext,
        null,
        [],
        [
          createAttachmentMessage({
            type: "plan_mode",
            reminderType: "full",
            isSubAgent: false,
            planFilePath: "/tmp/plan.md",
            planExists: false,
          } as never),
          createUserMessage({ content: "one" }),
        ],
      );

      expect(throttled.some(attachment => attachment.type === "plan_mode")).toBe(false);
    });

    test("emits a one-shot plan-mode exit attachment outside plan mode", async () => {
      setNeedsPlanModeExitAttachment(true);

      const first = await getAttachments(null, attachmentContext(), null, [], []);
      expect(first).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "plan_mode_exit",
            planExists: false,
          }),
        ]),
      );

      const second = await getAttachments(null, attachmentContext(), null, [], []);
      expect(second.some(attachment => attachment.type === "plan_mode_exit")).toBe(false);
    });

    test("includes critical system reminders from the tool-use context", async () => {
      const context = {
        ...attachmentContext(),
        criticalSystemReminder_EXPERIMENTAL: "Keep the safety invariant.",
      } as ToolUseContext;

      const attachments = await getAttachments(null, context, null, [], []);

      expect(attachments).toEqual(
        expect.arrayContaining([
          {
            type: "critical_system_reminder",
            content: "Keep the safety invariant.",
          },
        ]),
      );
    });

    test("adds TodoWrite reminders after enough assistant turns and respects recent reminders", async () => {
      const agentId = "agent-todo-reminder";
      const context = {
        ...attachmentContext(
          new Map(),
          createEmptyToolPermissionContext(),
          {
            tools: [{ name: "TodoWrite" }] as never,
          },
          {
            todos: {
              [agentId]: [
                {
                  content: "Ship the test tranche",
                  status: "pending",
                  activeForm: "Shipping the test tranche",
                },
              ],
            },
          },
        ),
        agentId,
      } as ToolUseContext;
      const oldAssistantTurns = Array.from({ length: 10 }, (_value, index) =>
        createAssistantMessage({ content: `assistant turn ${index}` }),
      );

      const reminder = await getAttachments(null, context, null, [], oldAssistantTurns);
      expect(reminder).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "todo_reminder",
            itemCount: 1,
            content: [
              expect.objectContaining({
                content: "Ship the test tranche",
              }),
            ],
          }),
        ]),
      );

      const recentlyReminded = await getAttachments(
        null,
        context,
        null,
        [],
        [
          createAttachmentMessage({
            type: "todo_reminder",
            content: [],
            itemCount: 0,
          } as never),
          createAssistantMessage({ content: "assistant turn after reminder" }),
        ],
      );

      expect(recentlyReminded.some(attachment => attachment.type === "todo_reminder")).toBe(false);
    });

    test("emits dynamic skill attachments from triggered directories once", async () => {
      await withTempWorkspace(".tmp-attachment-dynamic-skills-", async (workspace) => {
        const skillDir = join(workspace, "skills");
        await mkdir(join(skillDir, "alpha"), { recursive: true });
        await mkdir(join(skillDir, "not-a-skill"), { recursive: true });
        await writeFile(join(skillDir, "alpha", "SKILL.md"), "# Alpha\n", "utf8");
        await writeFile(join(skillDir, "not-a-skill", "README.md"), "# nope\n", "utf8");
        const context = {
          ...attachmentContext(),
          dynamicSkillDirTriggers: new Set([skillDir, join(workspace, "missing")]),
        } as ToolUseContext;

        const first = await getAttachments(null, context, null, [], []);
        expect(first).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "dynamic_skill",
              skillDir,
              skillNames: ["alpha"],
            }),
          ]),
        );

        const second = await getAttachments(null, context, null, [], []);
        expect(second.some(attachment => attachment.type === "dynamic_skill")).toBe(false);
      });
    });

    test("adds task reminders for task-enabled sessions and throttles recent reminders", async () => {
      await withTempWorkspace(".tmp-attachment-task-reminders-", async (workspace) => {
        process.env.AGENC_ENABLE_TASKS = "1";
        process.env.AGENC_TASK_LIST_ID = "attachment-task-reminder";
        process.env.AGENC_CONFIG_DIR = join(workspace, "home");
        delete process.env.USER_TYPE;

        await createTask(getTaskListId(), {
          subject: "Review task reminder",
          description: "Make sure task reminders surface.",
          activeForm: "Reviewing task reminder",
          status: "pending",
          blocks: [],
          blockedBy: [],
        });
        const context = attachmentContext(new Map(), createEmptyToolPermissionContext(), {
          tools: [{ name: "TaskUpdate" }] as never,
        });
        const messages = [
          createAssistantMessage({
            content: [
              {
                type: "tool_use",
                id: "task-update",
                name: "TaskUpdate",
                input: {},
              },
            ] as never,
          }),
          ...Array.from({ length: 10 }, (_value, index) =>
            createAssistantMessage({ content: `assistant task turn ${index}` }),
          ),
        ];

        const reminder = await getAttachments(null, context, null, [], messages);
        expect(reminder).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "task_reminder",
              itemCount: 1,
              content: [
                expect.objectContaining({
                  subject: "Review task reminder",
                }),
              ],
            }),
          ]),
        );

        const recentlyReminded = await getAttachments(
          null,
          context,
          null,
          [],
          [
            createAttachmentMessage({
              type: "task_reminder",
              content: [],
              itemCount: 0,
            } as never),
            createAssistantMessage({ content: "assistant turn after task reminder" }),
          ],
        );

        expect(recentlyReminded.some(attachment => attachment.type === "task_reminder")).toBe(false);
      });
    });

    test("processes agent and MCP resource mentions from user input", async () => {
      const context = attachmentContext(new Map(), createEmptyToolPermissionContext(), {
        agentDefinitions: {
          activeAgents: [
            { agentType: "reviewer" },
          ] as never,
          allowedAgentTypes: undefined,
        },
        mcpClients: [
          {
            name: "docs",
            type: "connected",
            client: {
              readResource: async ({ uri }: { uri: string }) => ({
                contents: [{ uri, text: "resource text" }],
              }),
            },
          },
        ] as never,
        mcpResources: {
          docs: [
            {
              uri: "guide",
              name: "Project guide",
              description: "Useful docs",
            },
          ],
        } as never,
      });

      const attachments = await runWithCurrentRuntimeSession(
        {
          conversationId: "attachment-extractor-test",
          services: { admissionRequired: false },
        } as unknown as Session,
        () =>
          getAttachments(
            "ask @agent-reviewer and @agent-ghost about @docs:guide",
            context,
            null,
            [],
            [],
          ),
      );

      expect(attachments).toEqual(
        expect.arrayContaining([
          { type: "agent_mention", agentType: "reviewer" },
          expect.objectContaining({
            type: "mcp_resource",
            server: "docs",
            uri: "guide",
            name: "Project guide",
            description: "Useful docs",
          }),
        ]),
      );
      expect(
        attachments.some(
          attachment =>
            attachment.type === "agent_mention" &&
            attachment.agentType === "ghost",
        ),
      ).toBe(false);
    });
  });

  describe("extractMcpResourceMentions ignores file mentions", () => {
    const cases: Array<[string, string]> = [
      ["a quoted Windows drive-letter path", '@"C:\\Users\\me\\file.txt"'],
      ["an unquoted Windows drive-letter path", "@C:\\Users\\me\\file.txt"],
      ["a quoted POSIX path with a space", '@"/Users/foo/my file.ts"'],
      ["an unquoted POSIX path", "@/Users/foo/bar.ts"],
      ["a quoted POSIX path with a colon in the name", '@"/tmp/weird:name.txt"'],
    ];

    test.each(cases)("%s", (_label, input) => {
      expect(extractMcpResourceMentions(input)).toEqual([]);
    });
  });

  describe("extractMcpResourceMentions matches legitimate MCP mentions", () => {
    const cases: Array<[string, string, string[]]> = [
      [
        "a simple server:resource token",
        "@server:resource/path",
        ["server:resource/path"],
      ],
      [
        "a plugin-scoped server name with a dash",
        "@asana-plugin:project-status/123",
        ["asana-plugin:project-status/123"],
      ],
      ["an MCP mention inline in prose", "please check @server:res here", ["server:res"]],
    ];

    test.each(cases)("%s", (_label, input, expected) => {
      expect(extractMcpResourceMentions(input)).toEqual(expected);
    });
  });

  describe("extractAtMentionedFiles extracts file paths", () => {
    const cases: Array<[string, string, string[]]> = [
      [
        "a quoted Windows drive-letter path",
        '@"C:\\Users\\me\\file.txt"',
        ["C:\\Users\\me\\file.txt"],
      ],
      [
        "a quoted POSIX path with a space",
        '@"/Users/foo/my file.ts"',
        ["/Users/foo/my file.ts"],
      ],
      ["an unquoted POSIX path", "@/Users/foo/bar.ts", ["/Users/foo/bar.ts"]],
    ];

    test.each(cases)("%s", (_label, input, expected) => {
      expect(extractAtMentionedFiles(input)).toEqual(expected);
    });
  });

  test("extracts agent mentions and file line ranges", () => {
    expect(
      extractAgentMentions(
        'ask @agent-code-review and @"asana:project.status (agent)" plus @agent-plugin@scope.worker',
      ),
    ).toEqual([
      "asana:project.status",
      "agent-code-review",
      "agent-plugin@scope.worker",
    ]);

    expect(parseAtMentionedFileLines("src/app.ts#L10-20")).toEqual({
      filename: "src/app.ts",
      lineStart: 10,
      lineEnd: 20,
    });
    expect(parseAtMentionedFileLines("src/app.ts#L7")).toEqual({
      filename: "src/app.ts",
      lineStart: 7,
      lineEnd: 7,
    });
    expect(parseAtMentionedFileLines("src/app.ts#heading")).toEqual({
      filename: "src/app.ts",
      lineStart: undefined,
      lineEnd: undefined,
    });
  });

  test("builds queued command attachments for inline notification modes", async () => {
    await expect(
      getQueuedCommandAttachments([
        {
          mode: "prompt",
          value: "run prompt",
          uuid: "cmd-1",
          isMeta: true,
          origin: { kind: "human" },
        },
        {
          mode: "task-notification",
          value: [{ type: "text", text: "task done" }],
          uuid: "cmd-2",
          origin: { kind: "task-notification" },
        },
        {
          mode: "bash",
          value: "echo skipped",
          uuid: "cmd-3",
        },
      ] as never),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "queued_command",
        prompt: "run prompt",
        source_uuid: "cmd-1",
        commandMode: "prompt",
        isMeta: true,
      }),
      expect.objectContaining({
        type: "queued_command",
        prompt: [{ type: "text", text: "task done" }],
        source_uuid: "cmd-2",
        commandMode: "task-notification",
      }),
    ]);
  });

  test("collects and deduplicates surfaced memory attachments", () => {
    const previous = createAttachmentMessage({
      type: "relevant_memories",
      memories: [
        {
          path: "/tmp/a.md",
          content: "alpha",
          mtimeMs: 1,
          header: "A",
        },
        {
          path: "/tmp/b.md",
          content: "beta",
          mtimeMs: 2,
          header: "B",
        },
      ],
    } as never);

    const surfaced = collectSurfacedMemories([previous]);
    expect([...surfaced.paths]).toEqual(["/tmp/a.md", "/tmp/b.md"]);
    expect(surfaced.totalBytes).toBe("alphabeta".length);
    expect(memoryHeader("/tmp/a.md", 1)).toContain("/tmp/a.md");

    const cache = new Map<string, unknown>([
      ["/tmp/a.md", { content: "existing" }],
    ]);
    const filtered = filterDuplicateMemoryAttachments(
      [
        previous.attachment,
        { type: "text", content: "keep" },
      ] as never,
      cache as never,
    );
    expect(filtered).toEqual([
      expect.objectContaining({
        type: "relevant_memories",
        memories: [expect.objectContaining({ path: "/tmp/b.md" })],
      }),
      { type: "text", content: "keep" },
    ]);
    expect(cache.has("/tmp/b.md")).toBe(true);
  });

  test("collects recent successful tools before the last real turn boundary", () => {
    const olderUser = createUserMessage({ content: "older" });
    const lastUser = createUserMessage({ content: "current" });
    const assistant = createAssistantMessage({
      content: [
        toolUse("ok", "Bash"),
        toolUse("bad", "Edit"),
        toolUse("pending", "Read"),
      ] as never,
    });
    const results = createUserMessage({
      content: [toolResult("ok"), toolResult("bad", true)] as never,
      toolUseResult: {},
    });

    expect(
      collectRecentSuccessfulTools(
        [olderUser, lastUser, assistant, results],
        lastUser,
      ),
    ).toEqual(["Bash"]);
  });

  test("filters skill listings and counts verify-plan reminder turns", () => {
    expect(
      filterToBundledAndMcp([
        { name: "bundled", loadedFrom: "bundled" },
        { name: "mcp", loadedFrom: "mcp" },
        { name: "user", loadedFrom: "user" },
      ] as never),
    ).toEqual([
      { name: "bundled", loadedFrom: "bundled" },
      { name: "mcp", loadedFrom: "mcp" },
    ]);

    const many = Array.from({ length: 31 }, (_value, index) => ({
      name: `skill-${index}`,
      loadedFrom: index === 0 ? "bundled" : "mcp",
    }));
    expect(filterToBundledAndMcp(many as never)).toEqual([
      { name: "skill-0", loadedFrom: "bundled" },
    ]);

    expect(
      getVerifyPlanReminderTurnCount([
        createAttachmentMessage({ type: "plan_mode_exit" } as never),
        createUserMessage({ content: "one" }),
        createUserMessage({
          content: [toolResult("tool")] as never,
          toolUseResult: {},
        }),
        createUserMessage({ content: "two" }),
      ]),
    ).toBe(2);
  });

  describe("file attachment generation", () => {
    test("reads a text file through the canonical file-read tool", async () => {
      await withTempWorkspace(".tmp-attachment-read-", async (workspace) => {
        const filePath = join(workspace, "note.txt");
        await writeFile(filePath, "alpha\nbeta\n", "utf8");

        const attachment = await withUnadmittedTestSession(() =>
          generateFileAttachment(
            filePath,
            attachmentContext(),
            "attachment_success",
            "attachment_error",
            "at-mention",
          ),
        );

        expect(attachment).toMatchObject({
          type: "file",
          filename: filePath,
        });
        expect(JSON.stringify((attachment as { content?: unknown }).content)).toContain("alpha");
      });
    });

    test("returns already-read metadata when the cached timestamp still matches", async () => {
      await withTempWorkspace(".tmp-attachment-already-read-", async (workspace) => {
        const filePath = join(workspace, "cached.txt");
        const content = "cached\ncontent\n";
        await writeFile(filePath, content, "utf8");
        const fileStat = await stat(filePath);
        const readFileState = new Map<string, unknown>([
          [
            filePath,
            {
              content,
              timestamp: Math.floor(fileStat.mtimeMs),
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);

        const attachment = await generateFileAttachment(
          filePath,
          attachmentContext(readFileState),
          "attachment_success",
          "attachment_error",
          "at-mention",
        );

        expect(attachment).toMatchObject({
          type: "already_read_file",
          filename: filePath,
          content: {
            type: "text",
            file: {
              filePath,
              content,
              numLines: 3,
              startLine: 1,
              totalLines: 3,
            },
          },
        });
      });
    });

    test("short-circuits when a read deny rule matches the file path", async () => {
      await withTempWorkspace(".tmp-attachment-deny-", async (workspace) => {
        const filePath = join(workspace, "secret.txt");
        await writeFile(filePath, "secret\n", "utf8");
        const relativePath = relative(process.cwd(), filePath);
        const denyRule: PermissionRule = {
          source: "session",
          ruleBehavior: "deny",
          ruleValue: { toolName: "FileRead", ruleContent: relativePath },
        };
        const permissionContext = applyPermissionRulesToPermissionContext(
          createEmptyToolPermissionContext(),
          [denyRule],
        );

        const result = await withMockedCanonicalFileRead(
          (async () => {
            throw new Error("canonical reader should not be called");
          }) as typeof CanonicalFileReadTool.call,
          () =>
            generateFileAttachment(
              filePath,
              attachmentContext(new Map(), permissionContext),
              "attachment_success",
              "attachment_error",
              "at-mention",
            ),
        );

        expect(result).toBeNull();
      });
    });

    test("uses a compact reference when compact-mode canonical read is too large", async () => {
      await withTempWorkspace(".tmp-attachment-compact-", async (workspace) => {
        const filePath = join(workspace, "large.txt");
        await writeFile(filePath, "content\n", "utf8");

        const result = await withMockedCanonicalFileRead(
          (async () => ({
            data: {
              content:
                "File content (100000 tokens) exceeds maximum allowed tokens (25000).",
              isError: true,
            },
          })) as typeof CanonicalFileReadTool.call,
          () =>
            generateFileAttachment(
              filePath,
              attachmentContext(),
              "attachment_success",
              "attachment_error",
              "compact",
            ),
        );

        expect(result).toMatchObject({
          type: "compact_file_reference",
          filename: filePath,
        });
      });
    });

    test("drops oversized non-PDF at-mentions before canonical reading", async () => {
      await withTempWorkspace(".tmp-attachment-too-large-", async (workspace) => {
        const filePath = join(workspace, "too-large.txt");
        await writeFile(filePath, "x".repeat(300 * 1024), "utf8");

        const result = await withMockedCanonicalFileRead(
          (async () => {
            throw new Error("canonical reader should not be called");
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

        expect(result).toBeNull();
      });
    });

    test("returns null PDF references for non-PDFs and inaccessible PDFs", async () => {
      await withTempWorkspace(".tmp-attachment-pdf-reference-", async (workspace) => {
        const textPath = join(workspace, "note.txt");
        const missingPdfPath = join(workspace, "missing.pdf");
        await writeFile(textPath, "plain\n", "utf8");

        await expect(tryGetPDFReference(textPath)).resolves.toBeNull();
        await expect(tryGetPDFReference(missingPdfPath)).resolves.toBeNull();
      });
    });
  });

  describe("changed-file attachments", () => {
    test("emits a text diff for a cached file that changed on disk", async () => {
      await withTempWorkspace(".tmp-attachment-changed-text-", async (workspace) => {
        const filePath = join(workspace, "changed.txt");
        await writeFile(filePath, "old line\nshared\n", "utf8");
        const readFileState = new Map<string, unknown>([
          [
            filePath,
            {
              content: "old line\nshared\n",
              timestamp: 0,
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);
        await writeFile(filePath, "new line\nshared\n", "utf8");

        const attachments = await withUnadmittedTestSession(() =>
          getChangedFiles(attachmentContext(readFileState)),
        );

        expect(attachments).toEqual([
          expect.objectContaining({
            type: "edited_text_file",
            filename: filePath,
            snippet: expect.stringContaining("new line"),
          }),
        ]);
      });
    });

    test("skips range reads and unchanged cached files", async () => {
      await withTempWorkspace(".tmp-attachment-unchanged-", async (workspace) => {
        const rangedPath = join(workspace, "ranged.txt");
        const unchangedPath = join(workspace, "unchanged.txt");
        await writeFile(rangedPath, "ranged\n", "utf8");
        await writeFile(unchangedPath, "same\n", "utf8");
        const unchangedStat = await stat(unchangedPath);
        const readFileState = new Map<string, unknown>([
          [
            rangedPath,
            {
              content: "ranged\n",
              timestamp: 0,
              offset: 1,
              limit: 1,
            },
          ],
          [
            unchangedPath,
            {
              content: "same\n",
              timestamp: Math.floor(unchangedStat.mtimeMs),
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);

        await expect(getChangedFiles(attachmentContext(readFileState))).resolves.toEqual([]);
      });
    });

    test("evicts missing files from the read-state cache", async () => {
      await withTempWorkspace(".tmp-attachment-deleted-", async (workspace) => {
        const filePath = join(workspace, "deleted.txt");
        await writeFile(filePath, "removed\n", "utf8");
        const readFileState = new Map<string, unknown>([
          [
            filePath,
            {
              content: "removed\n",
              timestamp: 0,
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);
        await unlink(filePath);

        await expect(getChangedFiles(attachmentContext(readFileState))).resolves.toEqual([]);
        expect(readFileState.has(filePath)).toBe(false);
      });
    });

    test("preserves standalone canonical image media as edited-image attachments", async () => {
      await withTempWorkspace(".tmp-attachment-changed-image-", async (workspace) => {
        const filePath = join(workspace, "image.png");
        await writeFile(filePath, "new image bytes", "utf8");
        const imageData = {
          content: "Read image",
          contentItems: [
            { type: "input_text", text: "Read image" },
            { type: "input_image", image_url: "data:image/png;base64,YWJj" },
          ],
          metadata: { mediaType: "image/png" },
        };
        const readFileState = new Map<string, unknown>([
          [
            filePath,
            {
              content: "old image bytes",
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
      });
    });

    test("drops non-text canonical media from changed-file attachments", async () => {
      await withTempWorkspace(".tmp-attachment-changed-media-", async (workspace) => {
        const filePath = join(workspace, "doc.pdf");
        await writeFile(filePath, "new pdf bytes", "utf8");
        const readFileState = new Map<string, unknown>([
          [
            filePath,
            {
              content: "old pdf bytes",
              timestamp: 0,
              offset: undefined,
              limit: undefined,
            },
          ],
        ]);

        const result = await withMockedCanonicalFileRead(
          (async () => ({
            data: {
              content: "pdf text",
              metadata: { mediaType: "application/pdf" },
            },
          })) as typeof CanonicalFileReadTool.call,
          () => getChangedFiles(attachmentContext(readFileState)),
        );

        expect(result).toEqual([]);
      });
    });
  });

  describe("nested memory helper attachments", () => {
    test("computes nested directories from the workspace root to the target file", () => {
      const originalCwd = join(process.cwd(), "project");
      const targetPath = join(originalCwd, "src", "feature", "file.ts");

      const directories = getDirectoriesToProcess(targetPath, originalCwd);

      expect(directories.nestedDirs).toEqual([
        join(originalCwd, "src"),
        join(originalCwd, "src", "feature"),
      ]);
      expect(directories.cwdLevelDirs.at(-1)).toBe(originalCwd);
    });

    test("creates nested memory attachments once and records loaded paths", () => {
      const memoryPath = join(process.cwd(), "AGENC.memory.md");
      const readFileState = new Map<string, unknown>();
      const loadedNestedMemoryPaths = new Set<string>();
      const context = {
        ...attachmentContext(readFileState),
        loadedNestedMemoryPaths,
      } as unknown as ToolUseContext;

      const first = memoryFilesToAttachments(
        [
          {
            path: memoryPath,
            type: "AutoMem",
            content: "remember this",
          },
        ],
        context,
      );
      const second = memoryFilesToAttachments(
        [
          {
            path: memoryPath,
            type: "AutoMem",
            content: "remember this",
          },
        ],
        context,
      );

      expect(first).toEqual([
        expect.objectContaining({
          type: "nested_memory",
          path: memoryPath,
          content: expect.objectContaining({ content: "remember this" }),
        }),
      ]);
      expect(second).toEqual([]);
      expect(loadedNestedMemoryPaths.has(memoryPath)).toBe(true);
      expect(readFileState.get(memoryPath)).toMatchObject({
        content: "remember this",
        offset: undefined,
        limit: undefined,
      });
    });

    test("marks transformed memory content as a partial raw-content cache entry", () => {
      const memoryPath = join(process.cwd(), "AGENC.partial.md");
      const readFileState = new Map<string, unknown>();
      const context = attachmentContext(readFileState);

      const attachments = memoryFilesToAttachments(
        [
          {
            path: memoryPath,
            type: "AutoMem",
            content: "processed content",
            contentDiffersFromDisk: true,
            rawContent: "raw disk content",
          },
        ],
        context,
      );

      expect(attachments).toHaveLength(1);
      expect(readFileState.get(memoryPath)).toMatchObject({
        content: "raw disk content",
        isPartialView: true,
      });
    });

    test("skips memory files already present in read state", () => {
      const memoryPath = join(process.cwd(), "AGENC.cached.md");
      const readFileState = new Map<string, unknown>([
        [
          memoryPath,
          {
            content: "existing",
            timestamp: Date.now(),
            offset: undefined,
            limit: undefined,
          },
        ],
      ]);

      expect(
        memoryFilesToAttachments(
          [
            {
              path: memoryPath,
              type: "AutoMem",
              content: "new content",
            },
          ],
          attachmentContext(readFileState),
        ),
      ).toEqual([]);
    });
  });

  describe("date-change attachments", () => {
    test("records the first date and emits once when the local date advances", () => {
      const originalOverride = process.env.AGENC_OVERRIDE_DATE;
      try {
        setLastEmittedDate(null);
        process.env.AGENC_OVERRIDE_DATE = "2030-01-01";
        expect(getDateChangeAttachments(undefined)).toEqual([]);

        process.env.AGENC_OVERRIDE_DATE = "2030-01-02";
        expect(
          getDateChangeAttachments([createUserMessage({ content: "overnight" })]),
        ).toEqual([{ type: "date_change", newDate: "2030-01-02" }]);
        expect(getDateChangeAttachments(undefined)).toEqual([]);
      } finally {
        if (originalOverride === undefined) {
          delete process.env.AGENC_OVERRIDE_DATE;
        } else {
          process.env.AGENC_OVERRIDE_DATE = originalOverride;
        }
        setLastEmittedDate(null);
      }
    });
  });
});
