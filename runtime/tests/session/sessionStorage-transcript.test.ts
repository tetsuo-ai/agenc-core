import { afterEach, expect, test } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { clearAllSessions as clearSessionIngressState } from "../../src/services/api/sessionIngress.js";
import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from "../../src/bootstrap/state.js";
import {
  __setAgentMetadataWritePhaseForTesting,
  buildConversationChain,
  clearAgentTranscriptSubdir,
  cacheSessionTitle,
  clearSessionMetadata,
  getAgentTranscriptPath,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  getFirstMeaningfulUserMessageTextContent,
  getProjectDir,
  getSessionIdFromLog,
  getTranscriptPath,
  getTranscriptPathForSession,
  flushSessionStorage,
  hydrateRemoteSession,
  isChainParticipant,
  isCustomTitleEnabled,
  isEphemeralToolProgress,
  isLiteLog,
  isTranscriptMessage,
  linkSessionToPR,
  loadFullLog,
  loadTranscriptFromFile,
  loadTranscriptFile,
  readAgentMetadata,
  reAppendSessionMetadata,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  removeExtraFields,
  resetProjectForTesting,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
  sessionIdExists,
  setAgentTranscriptSubdir,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
  stripPersistedToolUseResultsFromJSONLBuffer,
  writeAgentMetadata,
} from "../../src/utils/sessionStorage.js";

const tempDirs: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000999";
const ts = "2026-04-02T00:00:00.000Z";
const originalConfigDir = process.env.AGENC_CONFIG_DIR;
const originalAgenCHome = process.env.AGENC_HOME;
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE;
const originalEnablePersistence = process.env.ENABLE_SESSION_PERSISTENCE;
const originalSessionAccessToken = process.env.AGENC_SESSION_ACCESS_TOKEN;
const originalAfterLastCompact = process.env.AGENC_AFTER_LAST_COMPACT;

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function base(uuid: string, parentUuid: string | null) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    cwd: "/tmp",
    userType: "external",
    sessionId,
    version: "test",
    isSidechain: false,
  };
}

function user(uuid: string, parentUuid: string | null, content: string) {
  return {
    ...base(uuid, parentUuid),
    type: "user",
    isMeta: false,
    message: {
      role: "user",
      content,
    },
  };
}

function assistant(uuid: string, parentUuid: string | null, text: string) {
  return {
    ...base(uuid, parentUuid),
    type: "assistant",
    message: {
      id: uuid,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "test-model",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function runtimeMessage<T extends Record<string, unknown>>(entry: T): T {
  const {
    parentUuid: _parentUuid,
    cwd: _cwd,
    userType: _userType,
    sessionId: _sessionId,
    version: _version,
    isSidechain: _isSidechain,
    ...message
  } = entry;
  return message as T;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startSessionIngressServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/session`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function compactBoundary(
  uuid: string,
  parentUuid: string | null,
  preservedSegment: {
    headUuid: string;
    anchorUuid: string;
    tailUuid: string;
  },
) {
  return {
    ...base(uuid, parentUuid),
    type: "system",
    subtype: "compact_boundary",
    level: "info",
    isMeta: false,
    content: "Conversation compacted",
    compactMetadata: {
      trigger: "manual",
      preTokens: 123,
      preservedSegment,
    },
  };
}

async function writeJsonl(entries: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenc-session-storage-"));
  tempDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return filePath;
}

async function writeTempFile(fileName: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenc-session-storage-"));
  tempDirs.push(dir);
  const filePath = join(dir, fileName);
  await writeFile(filePath, content);
  return filePath;
}

async function readJsonlEntries(filePath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function restoreOptionalEnv(
  name:
    | "AGENC_CONFIG_DIR"
    | "AGENC_HOME"
    | "TEST_ENABLE_SESSION_PERSISTENCE"
    | "ENABLE_SESSION_PERSISTENCE"
    | "AGENC_SESSION_ACCESS_TOKEN"
    | "AGENC_AFTER_LAST_COMPACT",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function configureIsolatedSession(): Promise<{
  configDir: string;
  cwd: string;
  projectDir: string;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "agenc-session-config-"));
  tempDirs.push(configDir);
  process.env.AGENC_CONFIG_DIR = configDir;
  delete process.env.AGENC_HOME;
  resetStateForTests();
  resetProjectForTesting();

  const cwd = join(configDir, "workspace", "project one");
  setOriginalCwd(cwd);
  switchSession(sessionId as never, null);

  return {
    configDir,
    cwd,
    projectDir: getProjectDir(cwd),
  };
}

afterEach(async () => {
  __setAgentMetadataWritePhaseForTesting(undefined);
  resetProjectForTesting();
  resetStateForTests();
  restoreOptionalEnv("AGENC_CONFIG_DIR", originalConfigDir);
  restoreOptionalEnv("AGENC_HOME", originalAgenCHome);
  restoreOptionalEnv("TEST_ENABLE_SESSION_PERSISTENCE", originalTestPersistence);
  restoreOptionalEnv("ENABLE_SESSION_PERSISTENCE", originalEnablePersistence);
  restoreOptionalEnv("AGENC_SESSION_ACCESS_TOKEN", originalSessionAccessToken);
  restoreOptionalEnv("AGENC_AFTER_LAST_COMPACT", originalAfterLastCompact);
  clearSessionIngressState();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("classifies transcript, chain, and ephemeral progress entries", () => {
  expect(isTranscriptMessage({ type: "user" } as never)).toBe(true);
  expect(isTranscriptMessage({ type: "assistant" } as never)).toBe(true);
  expect(isTranscriptMessage({ type: "attachment" } as never)).toBe(true);
  expect(isTranscriptMessage({ type: "system" } as never)).toBe(true);
  expect(isTranscriptMessage({ type: "progress" } as never)).toBe(false);

  expect(isChainParticipant({ type: "user" })).toBe(true);
  expect(isChainParticipant({ type: "progress" })).toBe(false);

  expect(isEphemeralToolProgress("bash_progress")).toBe(true);
  expect(isEphemeralToolProgress("powershell_progress")).toBe(true);
  expect(isEphemeralToolProgress("mcp_progress")).toBe(true);
  expect(isEphemeralToolProgress("other_progress")).toBe(false);
  expect(isEphemeralToolProgress(undefined)).toBe(false);
});

test("uses isolated session paths for transcripts and agent metadata", async () => {
  const { projectDir } = await configureIsolatedSession();
  const agentId = "agent-meta" as never;

  expect(getTranscriptPath()).toBe(join(projectDir, `${sessionId}.jsonl`));
  expect(getTranscriptPathForSession(sessionId)).toBe(
    join(projectDir, `${sessionId}.jsonl`),
  );
  expect(getTranscriptPathForSession("00000000-0000-4000-8000-000000000111"))
    .toBe(join(projectDir, "00000000-0000-4000-8000-000000000111.jsonl"));
  expect(isCustomTitleEnabled()).toBe(true);
  expect(await readAgentMetadata(agentId)).toBeNull();

  setAgentTranscriptSubdir("agent-meta", "workflow/run-1");
  const nestedPath = getAgentTranscriptPath(agentId);
  expect(nestedPath).toBe(
    join(
      projectDir,
      sessionId,
      "subagents",
      "workflow/run-1",
      "agent-agent-meta.jsonl",
    ),
  );

  await writeAgentMetadata(agentId, {
    agentType: "review",
    agentRoleWorkspaceId: "/workspace/review",
    agentRoleFingerprint: "review-fingerprint",
    worktreePath: "/tmp/worktree",
    description: "inspect changes",
  });
  expect(await readAgentMetadata(agentId)).toEqual({
    agentType: "review",
    agentRoleWorkspaceId: "/workspace/review",
    agentRoleFingerprint: "review-fingerprint",
    worktreePath: "/tmp/worktree",
    description: "inspect changes",
  });

  clearAgentTranscriptSubdir("agent-meta");
  expect(getAgentTranscriptPath(agentId)).toBe(
    join(projectDir, sessionId, "subagents", "agent-agent-meta.jsonl"),
  );
});

test("readAgentMetadata returns null for a corrupt sidecar instead of throwing", async () => {
  await configureIsolatedSession();
  const agentId = "agent-corrupt" as never;

  // Simulate a partial sidecar left by an older non-atomic writer.
  const metaPath = getAgentTranscriptPath(agentId).replace(
    /\.jsonl$/,
    ".meta.json",
  );
  await mkdir(dirname(metaPath), { recursive: true });
  await writeFile(metaPath, "{");

  await expect(readAgentMetadata(agentId)).resolves.toBeNull();
  await expect(
    readAgentMetadata(agentId, { strict: true }),
  ).rejects.toThrow("invalid agent metadata sidecar");
});

test("agent metadata publication is atomic, durable, and preserves permissions", async () => {
  await configureIsolatedSession();
  const agentId = "agent-atomic" as never;
  const metadataPath = getAgentTranscriptPath(agentId).replace(
    /\.jsonl$/,
    ".meta.json",
  );
  const oldMetadata = {
    agentType: "review",
    agentRoleWorkspaceId: "/workspace/review",
    agentRoleFingerprint: "old-fingerprint",
    description: "old metadata",
  };
  const newMetadata = {
    ...oldMetadata,
    agentRoleFingerprint: "new-fingerprint",
    description: "new metadata",
  };

  await writeAgentMetadata(agentId, oldMetadata);
  await chmod(metadataPath, 0o640);

  let crashCheckpointObserved = false;
  __setAgentMetadataWritePhaseForTesting(async (phase, paths) => {
    expect(phase).toBe("temporary-file-synced");
    crashCheckpointObserved = true;

    // Until atomic rename, strict readers continue to see the complete old
    // generation. The fully-written temporary generation is parseable too.
    await expect(readAgentMetadata(agentId, { strict: true })).resolves.toEqual(
      oldMetadata,
    );
    expect(JSON.parse(await readFile(paths.temporaryPath, "utf8"))).toEqual(
      newMetadata,
    );
    throw new Error("simulated crash before metadata rename");
  });

  await expect(writeAgentMetadata(agentId, newMetadata)).rejects.toThrow(
    "simulated crash before metadata rename",
  );
  expect(crashCheckpointObserved).toBe(true);
  await expect(readAgentMetadata(agentId, { strict: true })).resolves.toEqual(
    oldMetadata,
  );
  expect(
    (await readdir(dirname(metadataPath))).filter((entry) =>
      entry.startsWith(`${basename(metadataPath)}.`) &&
      entry.endsWith(".tmp"),
    ),
  ).toEqual([]);

  __setAgentMetadataWritePhaseForTesting(async () => {
    await expect(readAgentMetadata(agentId, { strict: true })).resolves.toEqual(
      oldMetadata,
    );
  });
  await writeAgentMetadata(agentId, newMetadata);
  await expect(readAgentMetadata(agentId, { strict: true })).resolves.toEqual(
    newMetadata,
  );
  expect((await stat(metadataPath)).mode & 0o777).toBe(0o640);
});

test("checks session file existence in the current project directory", async () => {
  const { projectDir } = await configureIsolatedSession();
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

  expect(sessionIdExists(sessionId)).toBe(false);
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, "");
  expect(sessionIdExists(sessionId)).toBe(true);
  expect(sessionIdExists("00000000-0000-4000-8000-000000000404")).toBe(false);
});

test("persists and re-appends session metadata entries", async () => {
  const { projectDir } = await configureIsolatedSession();
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  setSessionFileForTesting(transcriptPath);

  await saveCustomTitle(sessionId as never, "Custom title", transcriptPath);
  saveAiGeneratedTitle(sessionId as never, "AI title");
  saveTaskSummary(sessionId as never, "Working on tests");
  await saveTag(sessionId as never, "coverage", transcriptPath);
  await saveAgentName(sessionId as never, "Runtime Agent", transcriptPath);
  await saveAgentColor(sessionId as never, "blue", transcriptPath);
  saveAgentSetting("staff-engineer");
  cacheSessionTitle("Startup title");
  saveMode("coordinator");
  saveWorktreeState({
    originalCwd: "/repo",
    worktreePath: "/repo/.agenc-worktrees/feat",
    worktreeName: "feat",
    worktreeBranch: "worktree-feat",
    originalBranch: "main",
    originalHeadCommit: "abc123",
    sessionId,
    tmuxSessionName: "agenc-feat",
    hookBased: true,
    creationDurationMs: 999,
    usedSparsePaths: true,
  } as never);
  await linkSessionToPR(
    sessionId as never,
    42,
    "https://github.example/pull/42",
    "owner/repo",
    transcriptPath,
  );

  expect(getCurrentSessionTitle(sessionId as never)).toBe("Startup title");
  expect(getCurrentSessionTag(sessionId as never)).toBe("coverage");
  expect(getCurrentSessionAgentColor()).toBe("blue");

  reAppendSessionMetadata();

  const entries = await readJsonlEntries(transcriptPath);
  expect(entries.map((entry) => entry.type)).toEqual(
    expect.arrayContaining([
      "custom-title",
      "ai-title",
      "task-summary",
      "tag",
      "agent-name",
      "agent-color",
      "agent-setting",
      "mode",
      "worktree-state",
      "pr-link",
    ]),
  );
  expect(entries.filter((entry) => entry.type === "custom-title").at(-1))
    .toMatchObject({ customTitle: "Custom title", sessionId });
  expect(entries.filter((entry) => entry.type === "tag").at(-1))
    .toMatchObject({ tag: "coverage", sessionId });
  expect(entries.filter((entry) => entry.type === "worktree-state").at(-1))
    .toMatchObject({
      worktreeSession: {
        originalCwd: "/repo",
        worktreePath: "/repo/.agenc-worktrees/feat",
        worktreeName: "feat",
        worktreeBranch: "worktree-feat",
        originalBranch: "main",
        originalHeadCommit: "abc123",
        sessionId,
        tmuxSessionName: "agenc-feat",
        hookBased: true,
      },
    });
  expect(
    entries
      .filter((entry) => entry.type === "worktree-state")
      .at(-1)?.worktreeSession,
  ).not.toMatchObject({
    creationDurationMs: 999,
    usedSparsePaths: true,
  });
});

test("restores and clears in-memory session metadata", async () => {
  await configureIsolatedSession();

  restoreSessionMetadata({
    customTitle: "Restored title",
    tag: "restored",
    agentName: "Restored Agent",
    agentColor: "green",
    agentSetting: "reviewer",
    mode: "normal",
    worktreeSession: null,
    prNumber: 7,
    prUrl: "https://github.example/pull/7",
    prRepository: "owner/repo",
  });

  expect(getCurrentSessionTitle(sessionId as never)).toBe("Restored title");
  expect(getCurrentSessionTag(sessionId as never)).toBe("restored");
  expect(getCurrentSessionAgentColor()).toBe("green");

  clearSessionMetadata();
  expect(getCurrentSessionTitle(sessionId as never)).toBeUndefined();
  expect(getCurrentSessionTag(sessionId as never)).toBeUndefined();
  expect(getCurrentSessionAgentColor()).toBeUndefined();
});

test("hydrates lite logs with transcript messages and metadata", async () => {
  const worktreeSession = {
    originalCwd: "/repo",
    worktreePath: "/repo/.agenc-worktrees/feat",
    worktreeName: "feat",
    worktreeBranch: "worktree-feat",
    sessionId,
  };
  const replacement = {
    toolUseId: "tu_replace",
    blockIndex: 0,
    storageKey: "tool-results/tu_replace.json",
  };
  const fileSnapshot = {
    messageId: id(302),
    files: { "src/file.ts": { content: "before" } },
  };
  const attributionSnapshot = {
    type: "attribution-snapshot",
    messageId: id(302),
    surface: "cli",
    fileStates: {
      "src/file.ts": {
        contentHash: "hash",
        agentContribution: 10,
        mtime: 123,
      },
    },
  };
  const prompt = user(id(301), null, "hydrate this log");
  const response = assistant(id(302), id(301), "hydrated");
  const filePath = await writeJsonl([
    { type: "custom-title", sessionId, customTitle: "Hydrated title" },
    { type: "tag", sessionId, tag: "hydrated" },
    { type: "agent-name", sessionId, agentName: "Hydrator" },
    { type: "agent-color", sessionId, agentColor: "purple" },
    { type: "agent-setting", sessionId, agentSetting: "debugger" },
    { type: "mode", sessionId, mode: "coordinator" },
    { type: "worktree-state", sessionId, worktreeSession },
    {
      type: "pr-link",
      sessionId,
      prNumber: 88,
      prUrl: "https://github.example/pull/88",
      prRepository: "owner/repo",
      timestamp: ts,
    },
    { type: "summary", leafUuid: id(302), summary: "Hydrated summary" },
    {
      type: "file-history-snapshot",
      messageId: id(302),
      snapshot: fileSnapshot,
      isSnapshotUpdate: false,
    },
    attributionSnapshot,
    {
      type: "content-replacement",
      sessionId,
      replacements: [replacement],
    },
    prompt,
    response,
  ]);
  const liteLog = {
    date: ts,
    messages: [],
    fullPath: filePath,
    value: 7,
    created: new Date(ts),
    modified: new Date(ts),
    firstPrompt: "",
    messageCount: 0,
    isSidechain: false,
    isLite: true,
    sessionId,
  };

  expect(isLiteLog(liteLog as never)).toBe(true);
  expect(getSessionIdFromLog(liteLog as never)).toBe(sessionId);

  const hydrated = await loadFullLog(liteLog as never);
  expect(hydrated).toMatchObject({
    firstPrompt: "hydrate this log",
    messageCount: 2,
    summary: "Hydrated summary",
    customTitle: "Hydrated title",
    tag: "hydrated",
    agentName: "Hydrator",
    agentColor: "purple",
    agentSetting: "debugger",
    mode: "coordinator",
    worktreeSession,
    prNumber: 88,
    prUrl: "https://github.example/pull/88",
    prRepository: "owner/repo",
    leafUuid: id(302),
    contentReplacements: [replacement],
  });
  expect(hydrated.messages.map((message) => message.uuid)).toEqual([
    id(301),
    id(302),
  ]);
  expect(hydrated.fileHistorySnapshots).toEqual([fileSnapshot]);
  expect(hydrated.attributionSnapshots).toEqual([
    expect.objectContaining(attributionSnapshot),
  ]);
  expect(isLiteLog(hydrated)).toBe(false);
  expect(getSessionIdFromLog(hydrated)).toBe(sessionId);
});

test("loadFullLog returns the original lite log when hydration is impossible", async () => {
  const missing = {
    date: ts,
    messages: [],
    value: 0,
    created: new Date(ts),
    modified: new Date(ts),
    firstPrompt: "fallback",
    messageCount: 0,
    isSidechain: false,
    isLite: true,
    sessionId,
  };
  expect(await loadFullLog(missing as never)).toBe(missing);

  const corrupt = {
    ...missing,
    fullPath: await writeJsonl([{ type: "summary", summary: "no messages" }]),
  };
  expect(await loadFullLog(corrupt as never)).toBe(corrupt);
});

test("loads JSON and JSONL transcripts through loadTranscriptFromFile", async () => {
  const prompt = user(id(321), null, "jsonl prompt");
  const response = assistant(id(322), id(321), "jsonl response");
  const jsonlPath = await writeJsonl([
    { type: "custom-title", sessionId, customTitle: "JSONL title" },
    { type: "tag", sessionId, tag: "jsonl" },
    prompt,
    response,
  ]);

  const jsonlLog = await loadTranscriptFromFile(jsonlPath);
  expect(jsonlLog).toMatchObject({
    firstPrompt: "jsonl prompt",
    customTitle: "JSONL title",
    tag: "jsonl",
    leafUuid: id(322),
    messageCount: 2,
  });

  const jsonArrayPath = await writeTempFile(
    "session.json",
    JSON.stringify([prompt, response]),
  );
  const jsonArrayLog = await loadTranscriptFromFile(jsonArrayPath);
  expect(jsonArrayLog.messages.map((message) => message.uuid)).toEqual([
    id(321),
    id(322),
  ]);

  const jsonObjectPath = await writeTempFile(
    "session.json",
    JSON.stringify({ messages: [prompt] }),
  );
  expect((await loadTranscriptFromFile(jsonObjectPath)).messages).toHaveLength(1);

  const invalidPath = await writeTempFile("session.json", "{");
  await expect(loadTranscriptFromFile(invalidPath)).rejects.toThrow(
    /Invalid JSON/,
  );

  const emptyJsonlPath = await writeJsonl([]);
  await expect(loadTranscriptFromFile(emptyJsonlPath)).rejects.toThrow(
    /No messages found/,
  );
});

test("records transcript chains and queued session artifacts", async () => {
  const { projectDir } = await configureIsolatedSession();
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = "1";
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const internalEvents: Array<{
    eventType: string;
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  setInternalEventWriter(async (eventType, payload, options) => {
    internalEvents.push({ eventType, payload, options });
  });

  const prompt = runtimeMessage(user(id(401), null, "record this prompt"));
  const response = runtimeMessage(assistant(id(402), null, "recorded response"));
  await expect(
    recordTranscript([prompt, response] as never, {
      teamName: "Runtime Team",
      agentName: "Recorder",
    }),
  ).resolves.toBe(id(402));
  await flushSessionStorage();

  let entries = await readJsonlEntries(transcriptPath);
  expect(entries.filter((entry) => entry.type === "user")).toHaveLength(1);
  expect(entries.filter((entry) => entry.type === "assistant")).toHaveLength(1);
  expect(entries.find((entry) => entry.uuid === id(401))).toMatchObject({
    parentUuid: null,
    teamName: "Runtime Team",
    agentName: "Recorder",
    sessionId,
  });
  expect(entries.find((entry) => entry.uuid === id(402))).toMatchObject({
    parentUuid: id(401),
    sessionId,
  });
  expect(internalEvents.map((event) => event.payload.uuid)).toEqual([
    id(401),
    id(402),
  ]);

  await expect(recordTranscript([prompt, response] as never)).resolves.toBe(
    id(402),
  );
  await flushSessionStorage();
  entries = await readJsonlEntries(transcriptPath);
  expect(entries.filter((entry) => entry.type === "assistant")).toHaveLength(1);

  await recordQueueOperation({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: ts,
    sessionId: sessionId as never,
    content: "queued",
  });
  await recordFileHistorySnapshot(
    id(402) as never,
    {
      messageId: id(402),
      files: { "src/file.ts": { content: "after" } },
    } as never,
    false,
  );
  await recordAttributionSnapshot({
    type: "attribution-snapshot",
    messageId: id(402),
    surface: "cli",
    fileStates: {},
  } as never);
  await recordContentReplacement([
    {
      toolUseId: "tu_main",
      blockIndex: 0,
      storageKey: "tool-results/tu_main.json",
    } as never,
  ]);
  await recordContextCollapseCommit({
    collapseId: "collapse-1",
    summaryUuid: id(410),
    summaryContent: "summary content",
    summary: "summary",
    firstArchivedUuid: id(401),
    lastArchivedUuid: id(402),
  });
  await recordContextCollapseSnapshot({
    staged: [
      {
        startUuid: id(401),
        endUuid: id(402),
        summary: "staged summary",
        risk: 1,
        stagedAt: 123,
      },
    ],
    armed: true,
    lastSpawnTokens: 55,
  });
  await flushSessionStorage();

  entries = await readJsonlEntries(transcriptPath);
  expect(entries.map((entry) => entry.type)).toEqual(
    expect.arrayContaining([
      "queue-operation",
      "file-history-snapshot",
      "attribution-snapshot",
      "content-replacement",
      "marble-origami-commit",
      "marble-origami-snapshot",
    ]),
  );

  const sidechainMessage = runtimeMessage(
    assistant(id(403), null, "sidechain response"),
  );
  await recordSidechainTranscript([sidechainMessage] as never, "agent-side", id(402) as never);
  await recordContentReplacement(
    [
      {
        toolUseId: "tu_side",
        blockIndex: 1,
        storageKey: "tool-results/tu_side.json",
      } as never,
    ],
    "agent-side" as never,
  );
  await flushSessionStorage();

  const sidechainPath = getAgentTranscriptPath("agent-side" as never);
  const sidechainEntries = await readJsonlEntries(sidechainPath);
  expect(sidechainEntries.find((entry) => entry.uuid === id(403))).toMatchObject({
    isSidechain: true,
    agentId: "agent-side",
    parentUuid: id(402),
  });
  expect(sidechainEntries.find((entry) => entry.type === "content-replacement"))
    .toMatchObject({ agentId: "agent-side" });

  await removeTranscriptMessage(id(402) as never);
  await removeTranscriptMessage(id(499) as never);
  entries = await readJsonlEntries(transcriptPath);
  expect(entries.some((entry) => entry.uuid === id(402))).toBe(false);
});

test("hydrates a remote session through session ingress", async () => {
  const { projectDir } = await configureIsolatedSession();
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  process.env.AGENC_AFTER_LAST_COMPACT = "1";
  const remoteEntries = [
    user(id(501), null, "remote prompt"),
    assistant(id(502), id(501), "remote response"),
  ];
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
  }> = [];
  const server = await startSessionIngressServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ loglines: remoteEntries }));
  });

  try {
    await expect(hydrateRemoteSession(sessionId, server.url)).resolves.toBe(true);
    expect(requests).toEqual([
      {
        method: "GET",
        url: "/session?after_last_compact=true",
        authorization: "Bearer session-token",
      },
    ]);
    expect(
      await readJsonlEntries(join(projectDir, `${sessionId}.jsonl`)),
    ).toEqual(remoteEntries);
  } finally {
    await server.close();
  }
});

test("appends transcript messages to remote session ingress", async () => {
  await configureIsolatedSession();
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = "1";
  process.env.ENABLE_SESSION_PERSISTENCE = "1";
  process.env.AGENC_SESSION_ACCESS_TOKEN = "session-token";
  const putRequests: Array<{
    uuid: unknown;
    authorization: string | undefined;
    lastUuid: string | undefined;
  }> = [];
  const server = await startSessionIngressServer(async (request, response) => {
    if (request.method !== "PUT") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    putRequests.push({
      uuid: body.uuid,
      authorization: request.headers.authorization,
      lastUuid: request.headers["last-uuid"] as string | undefined,
    });
    response.statusCode = 201;
    response.end("{}");
  });

  try {
    setRemoteIngressUrlForTesting(server.url);
    const prompt = runtimeMessage(user(id(511), null, "remote append prompt"));
    const response = runtimeMessage(assistant(id(512), null, "remote append response"));
    await recordTranscript([prompt, response] as never);
    await flushSessionStorage();

    expect(putRequests).toEqual([
      {
        uuid: id(511),
        authorization: "Bearer session-token",
        lastUuid: undefined,
      },
      {
        uuid: id(512),
        authorization: "Bearer session-token",
        lastUuid: id(511),
      },
    ]);
  } finally {
    await server.close();
  }
});

test("extracts the first meaningful user text while skipping metadata", () => {
  const transcript = [
    {
      type: "user",
      isMeta: false,
      message: { role: "user", content: "<ide_context>noise</ide_context>" },
    },
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta prompt" },
    },
    {
      type: "user",
      isMeta: false,
      message: {
        role: "user",
        content: [
          { type: "text", text: "<hook-output>skip</hook-output>" },
          { type: "text", text: "<bash-input>ls -la</bash-input>" },
        ],
      },
    },
  ];

  expect(getFirstMeaningfulUserMessageTextContent(transcript as never)).toBe(
    "! ls -la",
  );
});

test("removeExtraFields strips persistence-only chain fields", () => {
  const transcript = [
    {
      ...user(id(90), null, "hello"),
      extra: "kept",
    },
  ];

  expect(removeExtraFields(transcript as never)).toEqual([
    {
      uuid: id(90),
      timestamp: ts,
      cwd: "/tmp",
      userType: "external",
      sessionId,
      version: "test",
      type: "user",
      isMeta: false,
      message: {
        role: "user",
        content: "hello",
      },
      extra: "kept",
    },
  ]);
});

test("loadTranscriptFile fails closed when preserved-segment tail is missing", async () => {
  const oldUser = user(id(1), null, "old user");
  const oldAssistant = assistant(id(2), id(1), "old assistant");
  const preservedHead = assistant(id(3), id(2), "preserved head");
  const boundary = compactBoundary(id(4), id(2), {
    headUuid: id(3),
    anchorUuid: id(5),
    tailUuid: id(30),
  });
  const summary = user(id(5), id(4), "summary");

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    boundary,
    summary,
  ]);

  const { messages } = await loadTranscriptFile(filePath);
  expect(messages.has(id(1))).toBe(false);
  expect(messages.has(id(2))).toBe(false);
  expect(messages.has(id(3))).toBe(false);
  expect(messages.has(id(4))).toBe(true);
  expect(messages.has(id(5))).toBe(true);

  const chain = buildConversationChain(messages, messages.get(id(5))!);
  expect(chain.map((message) => message.uuid)).toEqual([id(4), id(5)]);
});

test("loadTranscriptFile preserves and relinks a valid preserved segment", async () => {
  const oldUser = user(id(11), null, "old user");
  const oldAssistant = assistant(id(12), id(11), "old assistant");
  const preservedHead = assistant(id(13), id(12), "preserved head");
  const preservedTail = assistant(id(14), id(13), "preserved tail");
  const boundary = compactBoundary(id(15), id(12), {
    headUuid: id(13),
    anchorUuid: id(16),
    tailUuid: id(14),
  });
  const summary = user(id(16), id(15), "summary");

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    preservedTail,
    boundary,
    summary,
  ]);

  const { messages } = await loadTranscriptFile(filePath);
  expect(messages.has(id(11))).toBe(false);
  expect(messages.has(id(12))).toBe(false);
  expect(messages.has(id(13))).toBe(true);
  expect(messages.has(id(14))).toBe(true);
  expect(messages.get(id(13))?.parentUuid).toBe(id(16));
  expect(messages.get(id(14))?.parentUuid).toBe(id(13));

  const chain = buildConversationChain(messages, messages.get(id(14))!);
  expect(chain.map((message) => message.uuid)).toEqual([
    id(15),
    id(16),
    id(13),
    id(14),
  ]);
});

test("loadTranscriptFile fails closed when preserved-segment anchor is missing", async () => {
  const oldUser = user(id(21), null, "old user");
  const oldAssistant = assistant(id(22), id(21), "old assistant");
  const preservedHead = assistant(id(23), id(22), "preserved head");
  const preservedTail = assistant(id(24), id(23), "preserved tail");
  const boundary = compactBoundary(id(25), id(22), {
    headUuid: id(23),
    anchorUuid: id(26),
    tailUuid: id(24),
  });

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    preservedTail,
    boundary,
  ]);

  const { messages } = await loadTranscriptFile(filePath);
  expect(messages.has(id(21))).toBe(false);
  expect(messages.has(id(22))).toBe(false);
  expect(messages.has(id(23))).toBe(false);
  expect(messages.has(id(24))).toBe(false);
  expect(messages.has(id(25))).toBe(true);

  const chain = buildConversationChain(messages, messages.get(id(25))!);
  expect(chain.map((message) => message.uuid)).toEqual([id(25)]);
});

test("stripPersistedToolUseResultsFromJSONLBuffer drops raw toolUseResult while preserving preview content", () => {
  const persisted = user(id(31), null, "placeholder");
  persisted.message = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-31",
        is_error: false,
        content: "<persisted-output>\nPreview text\n</persisted-output>",
      },
    ],
  };
  (persisted as typeof persisted & { toolUseResult?: unknown }).toolUseResult = {
    stdout: "x".repeat(200_000),
    stderr: "",
  };

  const raw = Buffer.from(`${JSON.stringify(persisted)}\n`);
  const sanitized = stripPersistedToolUseResultsFromJSONLBuffer(raw);
  const [parsed] = JSON.parse(`[${sanitized.toString("utf8").trim()}]`) as Array<
    typeof persisted & { toolUseResult?: unknown }
  >;

  expect(parsed?.toolUseResult).toBeUndefined();
  expect(
    (parsed?.message.content as Array<{ content: string }>)[0]?.content,
  ).toContain("Preview text");
});

test("loadTranscriptFile omits raw toolUseResult for persisted-output transcript entries", async () => {
  const persisted = user(id(41), null, "placeholder");
  persisted.message = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-41",
        is_error: false,
        content: "<persisted-output>\nPreview text\n</persisted-output>",
      },
    ],
  };
  (persisted as typeof persisted & { toolUseResult?: unknown }).toolUseResult = {
    stdout: "y".repeat(200_000),
    stderr: "",
  };

  const filePath = await writeJsonl([persisted]);
  const { messages } = await loadTranscriptFile(filePath);
  const loaded = messages.get(id(41)) as
    | (typeof persisted & { toolUseResult?: unknown })
    | undefined;

  expect(loaded).toBeDefined();
  expect(loaded?.toolUseResult).toBeUndefined();
  expect(
    (loaded?.message.content as Array<{ content: string }>)[0]?.content,
  ).toContain("Preview text");
});
