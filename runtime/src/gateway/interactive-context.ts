import { createHash } from "node:crypto";
import type { PromptSection } from "../llm/prompt-envelope.js";
import type { LLMMessage } from "../llm/types.js";
import type { RuntimeExecutionLocation } from "../runtime-contract/types.js";
import type { SessionReadSeedEntry } from "../tools/system/filesystem.js";
import { normalizeWorkspaceRoot } from "../workflow/path-normalization.js";

export const SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY =
  "interactiveContextState";

export interface InteractiveContextPromptSnapshot {
  readonly baseSystemPrompt: string;
  readonly userContextBlocks: readonly PromptSection[];
  readonly systemContextBlocks: readonly PromptSection[];
  readonly sessionStartContextMessages: readonly LLMMessage[];
  readonly toolScopeFingerprint: string;
}

export interface InteractiveContextSummaryRef {
  readonly ownerSessionId: string;
  readonly path: string;
  readonly boundarySeq: number;
  readonly transcriptNextSeq: number;
  readonly updatedAt: number;
  readonly contentHash: string;
}

export interface InteractiveContextForkCarryover {
  readonly sourceSessionId?: string;
  readonly mode?: "same_location" | "translated" | "fresh";
  readonly notice?: string;
}

export interface InteractiveContextExecutionLocation {
  readonly mode: Extract<RuntimeExecutionLocation["mode"], "local" | "worktree">;
  readonly workspaceRoot?: string;
  readonly workingDirectory?: string;
  readonly gitRoot?: string;
  readonly worktreePath?: string;
  readonly worktreeRef?: string;
}

export interface InteractiveContextState {
  readonly version: 1;
  readonly executionLocation?: InteractiveContextExecutionLocation;
  readonly readSeeds: readonly SessionReadSeedEntry[];
  readonly defaultAdvertisedToolNames?: readonly string[];
  readonly discoveredToolNames?: readonly string[];
  readonly cacheSafePromptSnapshot?: InteractiveContextPromptSnapshot;
  readonly summaryRef?: InteractiveContextSummaryRef;
  readonly forkCarryover?: InteractiveContextForkCarryover;
}

export interface InteractiveContextRequest {
  readonly state: InteractiveContextState;
  readonly summaryText?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

function normalizePromptSections(
  sections: readonly PromptSection[] | undefined,
): readonly PromptSection[] {
  if (!sections || sections.length === 0) {
    return [];
  }
  return sections
    .filter(
      (section): section is PromptSection =>
        typeof section?.source === "string" &&
        section.source.trim().length > 0 &&
        typeof section.content === "string" &&
        section.content.trim().length > 0,
    )
    .map((section) => ({
      source: section.source.trim(),
      content: section.content.trim(),
    }));
}

function cloneMessages(
  messages: readonly LLMMessage[] | undefined,
): readonly LLMMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }
  return JSON.parse(JSON.stringify(messages)) as readonly LLMMessage[];
}

function cloneReadSeeds(
  entries: readonly SessionReadSeedEntry[] | undefined,
): readonly SessionReadSeedEntry[] {
  if (!entries || entries.length === 0) {
    return [];
  }
  return entries
    .filter(
      (entry): entry is SessionReadSeedEntry =>
        typeof entry?.path === "string" && entry.path.trim().length > 0,
    )
    .map((entry) => ({
      path: entry.path.trim(),
      ...(entry.content === undefined ? {} : { content: entry.content }),
      ...(typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
        ? { timestamp: entry.timestamp }
        : {}),
      ...(entry.viewKind ? { viewKind: entry.viewKind } : {}),
    }));
}

function cloneToolNames(
  toolNames: readonly string[] | undefined,
): readonly string[] {
  if (!toolNames || toolNames.length === 0) {
    return [];
  }
  return Array.from(
    new Set(
      toolNames
        .filter((toolName): toolName is string => typeof toolName === "string")
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  );
}

export function buildInteractiveToolScopeFingerprint(
  toolNames: readonly string[] | undefined,
): string {
  const normalized = [...new Set((toolNames ?? []).map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return createHash("sha256")
    .update(stableStringify(normalized))
    .digest("hex");
}

export function buildInteractivePromptSnapshot(params: {
  readonly baseSystemPrompt: string;
  readonly systemContextBlocks?: readonly PromptSection[];
  readonly userContextBlocks?: readonly PromptSection[];
  readonly sessionStartContextMessages?: readonly LLMMessage[];
  readonly toolScopeFingerprint?: string;
}): InteractiveContextPromptSnapshot {
  return {
    baseSystemPrompt: params.baseSystemPrompt,
    systemContextBlocks: normalizePromptSections(params.systemContextBlocks),
    userContextBlocks: normalizePromptSections(params.userContextBlocks),
    sessionStartContextMessages: cloneMessages(
      params.sessionStartContextMessages,
    ),
    toolScopeFingerprint:
      params.toolScopeFingerprint?.trim().length
        ? params.toolScopeFingerprint.trim()
        : buildInteractiveToolScopeFingerprint([]),
  };
}

export function normalizeInteractiveExecutionLocation(
  location: RuntimeExecutionLocation | InteractiveContextExecutionLocation | undefined,
): InteractiveContextExecutionLocation | undefined {
  if (!location) {
    return undefined;
  }
  if (location.mode !== "local" && location.mode !== "worktree") {
    return undefined;
  }
  const workspaceRoot = normalizeWorkspaceRoot(location.workspaceRoot);
  const workingDirectory = normalizeWorkspaceRoot(location.workingDirectory);
  const gitRoot = normalizeWorkspaceRoot(location.gitRoot);
  const worktreePath = normalizeWorkspaceRoot(location.worktreePath);
  return {
    mode: location.mode,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(gitRoot ? { gitRoot } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(typeof location.worktreeRef === "string" &&
    location.worktreeRef.trim().length > 0
      ? { worktreeRef: location.worktreeRef.trim() }
      : {}),
  };
}

export function sameInteractiveExecutionLocation(
  left: InteractiveContextExecutionLocation | undefined,
  right: InteractiveContextExecutionLocation | undefined,
): boolean {
  const normalizedLeft = normalizeInteractiveExecutionLocation(left);
  const normalizedRight = normalizeInteractiveExecutionLocation(right);
  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.mode === normalizedRight.mode &&
    normalizedLeft.workspaceRoot === normalizedRight.workspaceRoot &&
    normalizedLeft.workingDirectory === normalizedRight.workingDirectory &&
    normalizedLeft.gitRoot === normalizedRight.gitRoot &&
    normalizedLeft.worktreePath === normalizedRight.worktreePath
  );
}

function coerceSummaryRef(value: unknown): InteractiveContextSummaryRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.ownerSessionId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.boundarySeq !== "number" ||
    typeof record.transcriptNextSeq !== "number" ||
    typeof record.updatedAt !== "number" ||
    typeof record.contentHash !== "string"
  ) {
    return undefined;
  }
  return {
    ownerSessionId: record.ownerSessionId,
    path: record.path,
    boundarySeq: Math.floor(record.boundarySeq),
    transcriptNextSeq: Math.floor(record.transcriptNextSeq),
    updatedAt: record.updatedAt,
    contentHash: record.contentHash,
  };
}

function coerceForkCarryover(
  value: unknown,
): InteractiveContextForkCarryover | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sourceSessionId =
    typeof record.sourceSessionId === "string" &&
    record.sourceSessionId.trim().length > 0
      ? record.sourceSessionId.trim()
      : undefined;
  const mode =
    record.mode === "same_location" ||
    record.mode === "translated" ||
    record.mode === "fresh"
      ? record.mode
      : undefined;
  const notice =
    typeof record.notice === "string" && record.notice.trim().length > 0
      ? record.notice.trim()
      : undefined;
  if (!sourceSessionId && !mode && !notice) {
    return undefined;
  }
  return {
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(mode ? { mode } : {}),
    ...(notice ? { notice } : {}),
  };
}

function coercePromptSnapshot(
  value: unknown,
): InteractiveContextPromptSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.baseSystemPrompt !== "string" ||
    typeof record.toolScopeFingerprint !== "string"
  ) {
    return undefined;
  }
  return buildInteractivePromptSnapshot({
    baseSystemPrompt: record.baseSystemPrompt,
    systemContextBlocks: Array.isArray(record.systemContextBlocks)
      ? (record.systemContextBlocks as readonly PromptSection[])
      : [],
    userContextBlocks: Array.isArray(record.userContextBlocks)
      ? (record.userContextBlocks as readonly PromptSection[])
      : [],
    sessionStartContextMessages: Array.isArray(record.sessionStartContextMessages)
      ? (record.sessionStartContextMessages as readonly LLMMessage[])
      : [],
    toolScopeFingerprint: record.toolScopeFingerprint,
  });
}

export function coerceInteractiveContextState(
  value: unknown,
): InteractiveContextState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  const executionLocation = normalizeInteractiveExecutionLocation(
    record.executionLocation as RuntimeExecutionLocation | undefined,
  );
  const readSeeds = cloneReadSeeds(
    Array.isArray(record.readSeeds)
      ? (record.readSeeds as readonly SessionReadSeedEntry[])
      : [],
  );
  const defaultAdvertisedToolNames = cloneToolNames(
    Array.isArray(record.defaultAdvertisedToolNames)
      ? (record.defaultAdvertisedToolNames as readonly string[])
      : [],
  );
  const discoveredToolNames = cloneToolNames(
    Array.isArray(record.discoveredToolNames)
      ? (record.discoveredToolNames as readonly string[])
      : [],
  );
  const cacheSafePromptSnapshot = coercePromptSnapshot(
    record.cacheSafePromptSnapshot,
  );
  const summaryRef = coerceSummaryRef(record.summaryRef);
  const forkCarryover = coerceForkCarryover(record.forkCarryover);
  return {
    version: 1,
    readSeeds,
    ...(executionLocation ? { executionLocation } : {}),
    ...(defaultAdvertisedToolNames.length > 0
      ? { defaultAdvertisedToolNames }
      : {}),
    ...(discoveredToolNames.length > 0 ? { discoveredToolNames } : {}),
    ...(cacheSafePromptSnapshot ? { cacheSafePromptSnapshot } : {}),
    ...(summaryRef ? { summaryRef } : {}),
    ...(forkCarryover ? { forkCarryover } : {}),
  };
}

export function cloneInteractiveContextState(
  state: InteractiveContextState | undefined,
): InteractiveContextState | undefined {
  if (!state) {
    return undefined;
  }
  return {
    version: 1,
    readSeeds: cloneReadSeeds(state.readSeeds),
    ...(state.executionLocation
      ? {
          executionLocation: normalizeInteractiveExecutionLocation(
            state.executionLocation,
          )!,
        }
      : {}),
    ...(state.defaultAdvertisedToolNames
      ? {
          defaultAdvertisedToolNames: cloneToolNames(
            state.defaultAdvertisedToolNames,
          ),
        }
      : {}),
    ...(state.discoveredToolNames
      ? { discoveredToolNames: cloneToolNames(state.discoveredToolNames) }
      : {}),
    ...(state.cacheSafePromptSnapshot
      ? {
          cacheSafePromptSnapshot: buildInteractivePromptSnapshot(
            state.cacheSafePromptSnapshot,
          ),
        }
      : {}),
    ...(state.summaryRef ? { summaryRef: { ...state.summaryRef } } : {}),
    ...(state.forkCarryover ? { forkCarryover: { ...state.forkCarryover } } : {}),
  };
}
