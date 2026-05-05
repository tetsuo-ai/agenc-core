/**
 * branding-scan: allow donor source citation for the S-06 parity record
 * Ports openclaude `src/services/MagicDocs/magicDocs.ts` onto AgenC's
 * first-class file tools and subagent runner.
 *
 * Shape differences from upstream:
 *   - `FileRead` results are plain AgenC tool envelopes, so the service
 *     tracks tagged markdown from the file-read listener and reads the
 *     current bytes directly when the background update runs.
 *   - The background updater seeds the child session's read-before-edit
 *     state before running an Edit-only subagent.
 */

import { readFile, stat } from "node:fs/promises";

import type { LLMMessage } from "../../llm/types.js";
import type { Session } from "../../session/session.js";
import type { Tool } from "../../tools/types.js";
import {
  FILE_EDIT_TOOL_NAME,
  registerFileReadListener,
} from "../../tools/system/index.js";
import {
  recordSessionRead,
} from "../../tools/system/filesystem.js";
import { ROOT_AGENT_PATH } from "../../agents/registry.js";
import type { LiveAgent } from "../../agents/control.js";
import type {
  ChildToolPolicy,
  RunAgentParams,
} from "../../agents/run-agent.js";
import { buildMagicDocsUpdatePrompt } from "./prompts.js";

const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im;
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m;

type MagicDocInfo = {
  readonly path: string;
};

export type MagicDocsReadFileState = Map<string, unknown>;

export interface MagicDocsAgentRequest {
  readonly docPath: string;
  readonly currentDoc: string;
  readonly title: string;
  readonly instructions?: string;
  readonly prompt: string;
  readonly messages: readonly LLMMessage[];
  readonly session?: Session;
  readonly readFileState: MagicDocsReadFileState;
  readonly signal?: AbortSignal;
}

export type MagicDocsAgentRunner = (
  request: MagicDocsAgentRequest,
) => Promise<void>;

export interface MagicDocsPostSamplingContext {
  readonly messages: readonly LLMMessage[];
  readonly querySource?: string;
  readonly session?: Session;
  readonly readFileState?: ReadonlyMap<string, unknown>;
  readonly signal?: AbortSignal;
}

const trackedMagicDocs = new Map<string, MagicDocInfo>();

let unregisterReadListener: (() => void) | null = null;
let updateQueue: Promise<void> = Promise.resolve();
let agentRunnerForTests: MagicDocsAgentRunner | null = null;

function getErrnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function isInaccessibleFileError(error: unknown): boolean {
  const code = getErrnoCode(error);
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

function hasToolCallsInLastAssistantTurn(
  messages: readonly LLMMessage[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
}

export function clearTrackedMagicDocs(): void {
  trackedMagicDocs.clear();
}

export function trackedMagicDocPathsForTests(): readonly string[] {
  return [...trackedMagicDocs.keys()].sort();
}

export function setMagicDocsAgentRunnerForTests(
  runner: MagicDocsAgentRunner | null,
): void {
  agentRunnerForTests = runner;
}

export function resetMagicDocsForTests(): void {
  trackedMagicDocs.clear();
  updateQueue = Promise.resolve();
  agentRunnerForTests = null;
  if (unregisterReadListener !== null) {
    unregisterReadListener();
    unregisterReadListener = null;
  }
}

export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN);
  if (!match || !match[1]) {
    return null;
  }

  const title = match[1].trim();
  const headerEndIndex = match.index! + match[0].length;
  const afterHeader = content.slice(headerEndIndex);
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/);

  if (nextLineMatch && nextLineMatch[1]) {
    const italicsMatch = nextLineMatch[1].match(ITALICS_PATTERN);
    if (italicsMatch && italicsMatch[1]) {
      return {
        title,
        instructions: italicsMatch[1].trim(),
      };
    }
  }

  return { title };
}

export function registerMagicDoc(filePath: string): void {
  if (!trackedMagicDocs.has(filePath)) {
    trackedMagicDocs.set(filePath, { path: filePath });
  }
}

export function cloneMagicDocsReadFileState(
  state?: ReadonlyMap<string, unknown>,
): MagicDocsReadFileState {
  return new Map(state ? [...state.entries()] : []);
}

export function createMagicDocsEditPolicy(docPath: string): ChildToolPolicy {
  return (tool: Pick<Tool, "name">, input: Record<string, unknown>) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input.file_path === "string" &&
      input.file_path === docPath
    ) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    return {
      behavior: "deny" as const,
      message: `only ${FILE_EDIT_TOOL_NAME} is allowed for ${docPath}`,
      metadata: {
        reason: `only ${FILE_EDIT_TOOL_NAME} is allowed`,
      },
    };
  };
}

async function spawnMagicDocsLiveAgent(session: Session): Promise<LiveAgent> {
  const controlWithSpawn = session.services.agentControl as unknown as {
    spawn?: (opts: {
      readonly parentPath: string;
      readonly preferredNickname?: string;
    }) => Promise<LiveAgent>;
  };
  if (typeof controlWithSpawn.spawn === "function") {
    return controlWithSpawn.spawn({
      parentPath: ROOT_AGENT_PATH,
      preferredNickname: "magic-docs",
    });
  }

  const { ensureAgentControl } = await import("../../bin/delegate-tool.js");
  const { control } = ensureAgentControl(session);
  return control.spawn({
    parentPath: ROOT_AGENT_PATH,
    preferredNickname: "magic-docs",
  });
}

async function runMagicDocsAgentWithSubagent(
  request: MagicDocsAgentRequest,
): Promise<void> {
  if (!request.session) {
    throw new Error("MagicDocs update requires a live session");
  }
  if (request.signal?.aborted) return;

  const live = await spawnMagicDocsLiveAgent(request.session);
  const fileStats = await stat(request.docPath);
  recordSessionRead(live.agentId, request.docPath, {
    content: request.currentDoc,
    rawContent: request.currentDoc,
    timestamp: Number.isFinite(fileStats.mtimeMs)
      ? fileStats.mtimeMs
      : Date.now(),
    viewKind: "full",
  });

  const { runAgent } = await import("../../agents/run-agent.js");
  const params: RunAgentParams = {
    live,
    parent: request.session,
    initialMessages: [
      ...request.messages.map((message) => ({ ...message })),
      { role: "user", content: request.prompt },
    ],
    taskPrompt: request.prompt,
    toolAllowlist: [FILE_EDIT_TOOL_NAME],
    childToolPolicy: createMagicDocsEditPolicy(request.docPath),
    maxTurns: 2,
    silent: true,
    ...(request.signal !== undefined ? { externalSignal: request.signal } : {}),
  };

  for await (const _event of runAgent(params)) {
    // Consume the background run to completion; transcript relays are disabled.
  }
}

function magicDocsAgentRunner(): MagicDocsAgentRunner {
  return agentRunnerForTests ?? runMagicDocsAgentWithSubagent;
}

async function updateMagicDoc(
  docInfo: MagicDocInfo,
  context: MagicDocsPostSamplingContext,
): Promise<void> {
  let currentDoc: string;
  try {
    currentDoc = await readFile(docInfo.path, "utf8");
  } catch (error) {
    if (isInaccessibleFileError(error)) {
      trackedMagicDocs.delete(docInfo.path);
      return;
    }
    throw error;
  }

  const detected = detectMagicDocHeader(currentDoc);
  if (!detected) {
    trackedMagicDocs.delete(docInfo.path);
    return;
  }

  const readFileState = cloneMagicDocsReadFileState(context.readFileState);
  readFileState.delete(docInfo.path);
  const prompt = await buildMagicDocsUpdatePrompt(
    currentDoc,
    docInfo.path,
    detected.title,
    detected.instructions,
  );

  await magicDocsAgentRunner()({
    docPath: docInfo.path,
    currentDoc,
    title: detected.title,
    ...(detected.instructions !== undefined
      ? { instructions: detected.instructions }
      : {}),
    prompt,
    messages: context.messages,
    ...(context.session !== undefined ? { session: context.session } : {}),
    readFileState,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
}

async function updateMagicDocs(
  context: MagicDocsPostSamplingContext,
): Promise<void> {
  if (context.signal?.aborted) return;
  if (context.querySource !== undefined && context.querySource !== "repl_main_thread") {
    return;
  }
  if (hasToolCallsInLastAssistantTurn(context.messages)) {
    return;
  }
  if (trackedMagicDocs.size === 0) {
    return;
  }

  for (const docInfo of [...trackedMagicDocs.values()]) {
    if (context.signal?.aborted) return;
    await updateMagicDoc(docInfo, context);
  }
}

export function runMagicDocsPostSamplingHook(
  context: MagicDocsPostSamplingContext,
): Promise<void> {
  updateQueue = updateQueue.then(
    () => updateMagicDocs(context),
    () => updateMagicDocs(context),
  );
  return updateQueue;
}

export function initMagicDocs(): void {
  if (unregisterReadListener !== null) return;
  unregisterReadListener = registerFileReadListener((filePath, content) => {
    if (detectMagicDocHeader(content)) {
      registerMagicDoc(filePath);
    }
  });
}
