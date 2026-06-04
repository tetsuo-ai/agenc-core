import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UUID } from "node:crypto";

import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from "../../src/bootstrap/state.js";
import type { Message } from "../../src/types/message.js";
import {
  cleanMessagesForLogging,
  clearSessionMessagesCache,
  createProjectForTesting,
  adoptResumedSessionFile,
  cacheSessionTitle,
  buildConversationChain,
  checkResumeConsistency,
  doesMessageExistInSession,
  enrichLogs,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  findUnresolvedToolUse,
  getAgentTranscript,
  getAgentTranscriptPath,
  getLogByIndex,
  getLastSessionLog,
  getProjectDir,
  getProjectsDir,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  getTranscriptPath,
  getTranscriptPathForSession,
  hydrateFromCCRv2InternalEvents,
  loadAllLogsFromSessionFile,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadAllSubagentTranscriptsFromDisk,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  loadSubagentTranscripts,
  loadTranscriptFile,
  resetProjectForTesting,
  resetProjectFlushStateForTesting,
  resetSessionFilePointer,
  searchSessionsByCustomTitle,
  setInternalEventReader,
} from "../../src/utils/sessionStorage.js";

const tempDirs: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000888";
const originalConfigDir = process.env.AGENC_CONFIG_DIR;
const originalAgenCHome = process.env.AGENC_HOME;
const originalUserType = process.env.USER_TYPE;
const originalSaveHookContext = process.env.AGENC_SAVE_HOOK_ADDITIONAL_CONTEXT;

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UUID;
}

function base(uuid: UUID, parentUuid: UUID | null, sid: string = sessionId) {
  return {
    uuid,
    parentUuid,
    timestamp: `2026-04-02T00:00:${String(Number(uuid.slice(-2)) % 60).padStart(2, "0")}.000Z`,
    cwd: "/tmp/project",
    userType: "external",
    sessionId: sid,
    version: "test",
    isSidechain: false,
  };
}

function user(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    ...base(uuid, parentUuid),
    type: "user",
    isMeta: false,
    message: {
      role: "user",
      content,
    },
    ...extra,
  };
}

function assistant(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    ...base(uuid, parentUuid),
    type: "assistant",
    message: {
      id: uuid,
      type: "message",
      role: "assistant",
      content,
      model: "test-model",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    ...extra,
  };
}

function assistantWithMessageId(
  uuid: UUID,
  parentUuid: UUID | null,
  content: unknown,
  messageId: string,
) {
  const entry = assistant(uuid, parentUuid, content);
  return {
    ...entry,
    message: {
      ...entry.message,
      id: messageId,
    },
  };
}

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function configureIsolatedSession(cwdName = "project-one"): Promise<{
  configDir: string;
  cwd: string;
  projectDir: string;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "agenc-session-read-"));
  tempDirs.push(configDir);
  process.env.AGENC_CONFIG_DIR = configDir;
  delete process.env.AGENC_HOME;
  resetStateForTests();
  resetProjectForTesting();
  clearSessionMessagesCache();

  const cwd = join(configDir, "workspace", cwdName);
  setOriginalCwd(cwd);
  switchSession(sessionId as never, null);
  const projectDir = getProjectDir(cwd);
  await mkdir(projectDir, { recursive: true });
  return { configDir, cwd, projectDir };
}

afterEach(async () => {
  clearSessionMessagesCache();
  resetProjectForTesting();
  resetStateForTests();
  restoreOptionalEnv("AGENC_CONFIG_DIR", originalConfigDir);
  restoreOptionalEnv("AGENC_HOME", originalAgenCHome);
  restoreOptionalEnv("USER_TYPE", originalUserType);
  restoreOptionalEnv("AGENC_SAVE_HOOK_ADDITIONAL_CONTEXT", originalSaveHookContext);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("loads lite session files, enriches resume metadata, and resolves log indexes", async () => {
  const { cwd, projectDir } = await configureIsolatedSession();
  const visibleSession = sessionId;
  const sidechainSession = "00000000-0000-4000-8000-000000000889";
  const teammateSession = "00000000-0000-4000-8000-000000000890";

  await writeJsonl(join(projectDir, `${visibleSession}.jsonl`), [
    user(id(1), null, "Visible prompt", { gitBranch: "main", cwd }),
    assistant(id(2), id(1), [{ type: "text", text: "response" }], { gitBranch: "feature/read" }),
    { type: "last-prompt", sessionId: visibleSession, lastPrompt: "Tail prompt wins" },
    { type: "custom-title", sessionId: visibleSession, customTitle: "Readable Session" },
    { type: "summary", leafUuid: id(2), summary: "short summary" },
    { type: "tag", sessionId: visibleSession, tag: "important" },
    { type: "agent-setting", sessionId: visibleSession, agentSetting: "planner" },
    {
      type: "pr-link",
      sessionId: visibleSession,
      prNumber: 42,
      prUrl: "https://example.test/pr/42",
      prRepository: "owner/repo",
      timestamp: "2026-04-02T00:00:10.000Z",
    },
  ]);
  await writeJsonl(join(projectDir, `${sidechainSession}.jsonl`), [
    user(id(3), null, "hidden sidechain", { sessionId: sidechainSession, isSidechain: true, cwd }),
  ]);
  await writeJsonl(join(projectDir, `${teammateSession}.jsonl`), [
    user(id(4), null, "hidden teammate", { sessionId: teammateSession, teamName: "alpha", cwd }),
  ]);
  await writeJsonl(join(projectDir, "not-a-session.jsonl"), [
    user(id(5), null, "invalid name", { cwd }),
  ]);

  const files = await getSessionFilesWithMtime(projectDir);
  expect([...files.keys()].sort()).toEqual([sidechainSession, teammateSession, visibleSession].sort());

  const liteLogs = await getSessionFilesLite(projectDir, undefined, cwd);
  expect(liteLogs).toHaveLength(3);
  expect(liteLogs.every((log) => log.isLite)).toBe(true);

  const enriched = await enrichLogs(liteLogs, 0, 3);
  expect(enriched.nextIndex).toBe(3);
  expect(enriched.logs).toHaveLength(1);
  expect(enriched.logs[0]).toMatchObject({
    firstPrompt: "Tail prompt wins",
    customTitle: "Readable Session",
    summary: "short summary",
    tag: "important",
    agentSetting: "planner",
    prNumber: 42,
    prUrl: "https://example.test/pr/42",
    prRepository: "owner/repo",
    gitBranch: "feature/read",
    projectPath: cwd,
  });

  const messageLogs = await loadMessageLogs();
  expect(messageLogs).toHaveLength(1);
  expect(messageLogs[0]!.value).toBe(0);
  await expect(getLogByIndex(0)).resolves.toMatchObject({
    customTitle: "Readable Session",
    firstPrompt: "Tail prompt wins",
  });
  await expect(getLogByIndex(9)).resolves.toBeNull();
  await expect(searchSessionsByCustomTitle("readable")).resolves.toHaveLength(1);
  await expect(
    searchSessionsByCustomTitle("Readable Session", { exact: true, limit: 1 }),
  ).resolves.toMatchObject([{ customTitle: "Readable Session" }]);
  await expect(searchSessionsByCustomTitle("missing")).resolves.toEqual([]);
});

test("loads all project logs through progressive and full scan paths", async () => {
  const { configDir, cwd, projectDir } = await configureIsolatedSession("project-a");
  const otherCwd = join(configDir, "workspace", "project-b");
  const otherProjectDir = getProjectDir(otherCwd);
  await mkdir(otherProjectDir, { recursive: true });
  const otherSession = "00000000-0000-4000-8000-000000000891";

  await writeJsonl(join(projectDir, `${sessionId}.jsonl`), [
    user(id(10), null, "Prompt from A", { cwd }),
    assistant(id(11), id(10), [{ type: "text", text: "A" }], { cwd }),
  ]);
  await writeJsonl(join(otherProjectDir, `${otherSession}.jsonl`), [
    user(id(12), null, "Prompt from B", { sessionId: otherSession, cwd: otherCwd }),
    assistant(id(13), id(12), [{ type: "text", text: "B" }], {
      sessionId: otherSession,
      cwd: otherCwd,
    }),
  ]);

  const progressive = await loadAllProjectsMessageLogsProgressive(undefined, 1);
  expect(progressive.allStatLogs).toHaveLength(2);
  expect(progressive.logs).toHaveLength(1);
  expect(progressive.nextIndex).toBe(1);

  const defaultAllProjects = await loadAllProjectsMessageLogs(undefined, {
    initialEnrichCount: 2,
  });
  expect(defaultAllProjects.map((log) => log.firstPrompt).sort()).toEqual([
    "Prompt from A",
    "Prompt from B",
  ]);

  const fullScan = await loadAllProjectsMessageLogs(undefined, { skipIndex: true });
  expect(fullScan.map((log) => log.firstPrompt).sort()).toEqual([
    "Prompt from A",
    "Prompt from B",
  ]);
});

test("loads same-repo worktree logs from matching project directories", async () => {
  const { configDir, cwd, projectDir } = await configureIsolatedSession("repo");
  const worktreeCwd = join(configDir, "workspace", "repo-feature");
  const worktreeProjectDir = getProjectDir(worktreeCwd);
  await mkdir(worktreeProjectDir, { recursive: true });
  const worktreeSession = "00000000-0000-4000-8000-000000000892";

  await writeJsonl(join(projectDir, `${sessionId}.jsonl`), [
    user(id(20), null, "Main worktree prompt", { cwd }),
  ]);
  await writeJsonl(join(worktreeProjectDir, `${worktreeSession}.jsonl`), [
    user(id(21), null, "Feature worktree prompt", {
      sessionId: worktreeSession,
      cwd: worktreeCwd,
    }),
  ]);

  const currentOnly = await loadSameRepoMessageLogsProgressive([cwd], undefined, 5);
  expect(currentOnly.logs.map((log) => log.firstPrompt)).toEqual(["Main worktree prompt"]);

  const both = await loadSameRepoMessageLogsProgressive([cwd, worktreeCwd], undefined, 5);
  expect(both.logs.map((log) => log.firstPrompt).sort()).toEqual([
    "Feature worktree prompt",
    "Main worktree prompt",
  ]);
  expect(both.allStatLogs).toHaveLength(2);

  const wrapper = await loadSameRepoMessageLogs([cwd, worktreeCwd], undefined, 5);
  expect(wrapper.map((log) => log.firstPrompt).sort()).toEqual([
    "Feature worktree prompt",
    "Main worktree prompt",
  ]);
});

test("loads full logs from a session file with leaf metadata and trailing children", async () => {
  const { cwd, projectDir } = await configureIsolatedSession();
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  await writeJsonl(sessionFile, [
    user(id(30), null, "Root prompt", { cwd }),
    assistant(id(31), id(30), [{ type: "text", text: "Leaf response" }], { cwd }),
    user(id(32), id(31), "Trailing child", { cwd }),
    { type: "custom-title", sessionId, customTitle: "Full log title" },
    { type: "tag", sessionId, tag: "full" },
    { type: "agent-name", sessionId, agentName: "Agent Smith" },
    { type: "agent-color", sessionId, agentColor: "blue" },
    { type: "agent-setting", sessionId, agentSetting: "reviewer" },
    { type: "mode", sessionId, mode: "coordinator" },
  ]);

  const logs = await loadAllLogsFromSessionFile(sessionFile, "/override/project");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    firstPrompt: "Root prompt",
    customTitle: "Full log title",
    tag: "full",
    agentName: "Agent Smith",
    agentColor: "blue",
    agentSetting: "reviewer",
    mode: "coordinator",
    projectPath: "/override/project",
  });
  expect(logs[0]!.messages.map((message) => message.uuid)).toEqual([id(30), id(31), id(32)]);
  await expect(doesMessageExistInSession(sessionId as UUID, id(31))).resolves.toBe(true);
  await expect(doesMessageExistInSession(sessionId as UUID, id(99))).resolves.toBe(false);
  await expect(getLastSessionLog(sessionId as UUID)).resolves.toMatchObject({
    firstPrompt: "Root prompt",
    customTitle: "Full log title",
  });
});

test("hydrates CCR v2 internal events into foreground and subagent transcripts", async () => {
  await configureIsolatedSession();
  const agentId = "worker-two";

  await expect(hydrateFromCCRv2InternalEvents(sessionId)).resolves.toBe(false);

  setInternalEventReader(
    async () => null,
    async () => [],
  );
  await expect(hydrateFromCCRv2InternalEvents(sessionId)).resolves.toBe(false);

  setInternalEventReader(
    async () => [{ payload: user(id(70), null, "foreground event") }],
    async () => [
      {
        agent_id: agentId,
        payload: user(id(71), null, "subagent event", {
          isSidechain: true,
          agentId,
        }),
      },
      {
        agent_id: "",
        payload: user(id(72), null, "ignored missing agent", {
          isSidechain: true,
        }),
      },
    ],
  );

  await expect(hydrateFromCCRv2InternalEvents(sessionId)).resolves.toBe(true);
  const foreground = (await readFile(getTranscriptPathForSession(sessionId), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(foreground).toEqual([expect.objectContaining({ uuid: id(70) })]);
  await expect(getAgentTranscript(agentId as never)).resolves.toMatchObject({
    messages: [expect.objectContaining({ uuid: id(71) })],
  });

  setInternalEventReader(
    async () => {
      throw new Error("CCRClient: Epoch mismatch (409)");
    },
    async () => [],
  );
  await expect(hydrateFromCCRv2InternalEvents(sessionId)).rejects.toThrow(
    "CCRClient: Epoch mismatch (409)",
  );

  setInternalEventReader(
    async () => {
      throw new Error("reader failed");
    },
    async () => [],
  );
  await expect(hydrateFromCCRv2InternalEvents(sessionId)).resolves.toBe(false);
});

test("adopts a resumed session file and re-appends cached metadata", async () => {
  await configureIsolatedSession();
  await writeJsonl(getTranscriptPath(), [user(id(80), null, "resumed prompt")]);

  cacheSessionTitle("Adopted title");
  resetSessionFilePointer();
  adoptResumedSessionFile();

  const lines = (await readFile(getTranscriptPath(), "utf8")).trim().split("\n");
  expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
    expect.objectContaining({ uuid: id(80) }),
    expect.objectContaining({
      type: "custom-title",
      customTitle: "Adopted title",
      sessionId,
    }),
  ]);
});

test("exposes a project write handle for drain and append failure tests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenc-project-handle-"));
  tempDirs.push(dir);
  const filePath = join(dir, "queued.jsonl");
  const projectHandle = createProjectForTesting();
  const writes: string[] = [];

  expect(projectHandle.flushIntervalMs).toBeGreaterThan(0);
  projectHandle.setAppendOverride(async (_filePath, data) => {
    writes.push(data);
  });
  await projectHandle.enqueueWrite(filePath, {
    type: "tag",
    sessionId: sessionId as UUID,
    tag: "queued",
  });
  await projectHandle.flush();
  expect(writes).toEqual([
    `${JSON.stringify({ type: "tag", sessionId, tag: "queued" })}\n`,
  ]);

  projectHandle.setAppendOverride(async () => {
    throw new Error("disk full");
  });
  await expect(
    projectHandle.enqueueWrite(filePath, {
      type: "custom-title",
      sessionId: sessionId as UUID,
      customTitle: "still resolves",
    }),
  ).resolves.toBeUndefined();
  await expect(projectHandle.flush()).resolves.toBeUndefined();
  resetProjectFlushStateForTesting();
});

test("finds unresolved tool uses and ignores resolved ones", async () => {
  await configureIsolatedSession();
  await writeJsonl(getTranscriptPath(), [
    user(id(40), null, "Run a tool"),
    assistant(id(41), id(40), [
      { type: "text", text: "checking" },
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]),
  ]);

  await expect(findUnresolvedToolUse("tool-1")).resolves.toMatchObject({
    uuid: id(41),
    type: "assistant",
  });

  await writeJsonl(getTranscriptPath(), [
    user(id(40), null, "Run a tool"),
    assistant(id(41), id(40), [
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]),
    user(id(42), id(41), [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]),
  ]);
  await expect(findUnresolvedToolUse("tool-1")).resolves.toBeNull();
});

test("bridges legacy progress entries and applies snip removals on transcript load", async () => {
  const { projectDir } = await configureIsolatedSession();
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  const progressUuid = id(101);
  const removedUuid = id(103);
  await writeJsonl(filePath, [
    user(id(100), null, "root"),
    {
      type: "progress",
      uuid: progressUuid,
      parentUuid: id(100),
      timestamp: "2026-04-02T00:01:41.000Z",
    },
    assistant(id(102), progressUuid, [{ type: "text", text: "after progress" }]),
    user(removedUuid, id(102), "removed by snip"),
    assistant(id(104), removedUuid, [{ type: "text", text: "survives snip" }]),
    {
      ...base(id(105), id(104)),
      type: "system",
      subtype: "compact_boundary",
      level: "info",
      content: "snipped",
      snipMetadata: { removedUuids: [removedUuid] },
    },
  ]);

  const loaded = await loadTranscriptFile(filePath);
  expect(loaded.messages.get(id(102))!.parentUuid).toBe(id(100));
  expect(loaded.messages.has(removedUuid)).toBe(false);
  expect(loaded.messages.get(id(104))!.parentUuid).toBe(id(102));
  checkResumeConsistency([...loaded.messages.values()] as never);
});

test("recovers orphaned parallel tool results when rebuilding a chain", async () => {
  const { projectDir } = await configureIsolatedSession();
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  await writeJsonl(filePath, [
    user(id(110), null, "parallel tools"),
    assistantWithMessageId(id(111), id(110), [
      { type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "a" } },
    ], "assistant-message-1"),
    assistantWithMessageId(id(112), id(111), [
      { type: "tool_use", id: "tool-b", name: "Read", input: { file_path: "b" } },
    ], "assistant-message-1"),
    user(id(113), id(111), [{ type: "tool_result", tool_use_id: "tool-a", content: "a" }]),
    user(id(114), id(112), [{ type: "tool_result", tool_use_id: "tool-b", content: "b" }]),
    assistant(id(115), id(113), [{ type: "text", text: "done" }]),
  ]);

  const { messages } = await loadTranscriptFile(filePath);
  const chain = buildConversationChain(messages, messages.get(id(115))!);
  expect(chain.map((message) => message.uuid)).toEqual([
    id(110),
    id(111),
    id(112),
    id(114),
    id(113),
    id(115),
  ]);
});

test("enriches lite logs from a truncated prompt prefix", async () => {
  const { cwd, projectDir } = await configureIsolatedSession();
  const truncatedSession = "00000000-0000-4000-8000-000000000893";
  await writeFile(
    join(projectDir, `${truncatedSession}.jsonl`),
    '{"type":"user","message":{"content":"Prompt recovered from prefix only',
  );

  const liteLogs = await getSessionFilesLite(projectDir, undefined, cwd);
  const { logs } = await enrichLogs(liteLogs, 0, liteLogs.length);
  expect(logs).toEqual([
    expect.objectContaining({
      sessionId: truncatedSession,
      firstPrompt: "Prompt recovered from prefix only",
    }),
  ]);
});

test("loads subagent transcripts from agent files and task state", async () => {
  await configureIsolatedSession();
  const agentId = "worker-one";
  const agentFile = getAgentTranscriptPath(agentId as never);
  await writeJsonl(agentFile, [
    user(id(50), null, "agent prompt", {
      isSidechain: true,
      agentId,
    }),
    assistant(id(51), id(50), [{ type: "text", text: "agent reply" }], {
      isSidechain: true,
      agentId,
    }),
    {
      type: "content-replacement",
      sessionId,
      agentId,
      replacements: [
        {
          kind: "tool-result",
          toolUseId: "tool-1",
          replacement: "[stored elsewhere]",
        },
      ],
    },
  ]);
  await writeJsonl(join(dirname(agentFile), "agent-ignored.txt"), []);

  await expect(getAgentTranscript(agentId as never)).resolves.toMatchObject({
    messages: [{ uuid: id(50) }, { uuid: id(51) }],
    contentReplacements: [{ toolUseId: "tool-1" }],
  });
  await expect(loadSubagentTranscripts([agentId, "missing-agent"])).resolves.toEqual({
    [agentId]: expect.arrayContaining([expect.objectContaining({ uuid: id(50) })]),
  });
  await expect(loadAllSubagentTranscriptsFromDisk()).resolves.toEqual({
    [agentId]: expect.arrayContaining([expect.objectContaining({ uuid: id(51) })]),
  });

  const progressMessages = [
    { type: "progress", data: { type: "agent_progress", agentId } },
    { type: "progress", data: { type: "skill_progress", agentId: "skill-one" } },
    { type: "progress", data: { type: "other", agentId: "ignored" } },
  ] as Message[];
  expect(extractAgentIdsFromMessages(progressMessages)).toEqual([agentId, "skill-one"]);

  const taskMessages = [{ type: "user", uuid: id(55), message: { role: "user", content: "task" } }] as Message[];
  expect(
    extractTeammateTranscriptsFromTasks({
      one: {
        type: "in_process_teammate",
        identity: { agentId: "teammate-one" },
        messages: taskMessages,
      },
      two: { type: "other", identity: { agentId: "ignored" }, messages: taskMessages },
    }),
  ).toEqual({ "teammate-one": taskMessages });
});

test("cleans transcript messages for external logging while preserving ant transcripts", () => {
  restoreOptionalEnv("USER_TYPE", undefined);
  process.env.AGENC_SAVE_HOOK_ADDITIONAL_CONTEXT = "1";
  const replAssistant = assistant(id(60), null, [
    { type: "tool_use", id: "repl-1", name: "REPL", input: {} },
    { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } },
  ]) as Message;
  const replResult = {
    ...user(id(61), id(60), [
      { type: "tool_result", tool_use_id: "repl-1", content: "hidden" },
      { type: "text", text: "visible" },
    ]),
    isVirtual: true,
  } as Message;
  const plainVirtual = { ...user(id(62), id(61), "plain virtual"), isVirtual: true } as Message;
  const normalAttachment = {
    type: "attachment",
    uuid: id(63),
    attachment: { type: "file", filePath: "/tmp/a.txt" },
  } as unknown as Message;
  const hookAttachment = {
    type: "attachment",
    uuid: id(64),
    attachment: { type: "hook_additional_context", content: "hook" },
  } as unknown as Message;
  const progress = { type: "progress", uuid: id(65), data: { type: "status" } } as unknown as Message;

  const cleaned = cleanMessagesForLogging(
    [replAssistant, replResult, plainVirtual, normalAttachment, hookAttachment, progress],
    [replAssistant],
  ) as Array<Record<string, unknown>>;

  expect(cleaned.map((message) => message.type)).toEqual([
    "assistant",
    "user",
    "user",
    "attachment",
  ]);
  expect((cleaned[0]!.message as { content: Array<{ id?: string }> }).content).toEqual([
    { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } },
  ]);
  expect(cleaned[1]).not.toHaveProperty("isVirtual");
  expect((cleaned[1]!.message as { content: Array<{ type: string }> }).content).toEqual([
    { type: "text", text: "visible" },
  ]);
  expect(cleaned[2]).not.toHaveProperty("isVirtual");

  process.env.USER_TYPE = "ant";
  const antCleaned = cleanMessagesForLogging([replAssistant, normalAttachment], [replAssistant]);
  expect(antCleaned).toHaveLength(2);
  expect((antCleaned[0]!.message.content as Array<{ id?: string }>).map((block) => block.id)).toEqual([
    "repl-1",
    "bash-1",
  ]);
});

test("returns empty read results for missing project and transcript files", async () => {
  const { projectDir } = await configureIsolatedSession();
  await rm(projectDir, { recursive: true, force: true });

  await expect(getSessionFilesWithMtime(projectDir)).resolves.toEqual(new Map());
  await expect(loadMessageLogs()).resolves.toEqual([]);
  await expect(loadAllProjectsMessageLogs()).resolves.toEqual([]);
  await expect(loadAllProjectsMessageLogsProgressive()).resolves.toEqual({
    logs: [],
    allStatLogs: [],
    nextIndex: 0,
  });
  await rm(getProjectsDir(), { recursive: true, force: true });
  await expect(loadSameRepoMessageLogsProgressive(["/missing-a", "/missing-b"])).resolves.toEqual({
    logs: [],
    allStatLogs: [],
    nextIndex: 0,
  });
});
