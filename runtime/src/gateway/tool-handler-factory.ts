/**
 * Shared session-scoped tool handler factory.
 *
 * Extracts the common hook → approval → routing → execution → notify pipeline
 * used by both the daemon (text-mode) and voice-bridge (legacy tool calls).
 *
 * @module
 */

import type { ControlResponse } from './types.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ToolHandler } from '../llm/types.js';
import {
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
} from "../tools/system/coding.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "../tools/system/filesystem.js";
import {
  TASK_ACTOR_KIND_ARG,
  TASK_ACTOR_NAME_ARG,
  TASK_LIST_ARG,
  TASK_TRACKER_TOOL_NAMES,
} from "../tools/system/task-tracker.js";
import type { TaskStore } from "../tools/system/task-tracker.js";
import {
  buildShellProfileApprovalContext,
  type SessionShellProfile,
} from "./shell-profile.js";
import {
  didToolCallFail,
  enrichToolResultMetadata,
  extractToolFailureTextFromResult,
  normalizeToolCallArguments,
} from '../llm/chat-executor-tool-utils.js';
import { TEST_FILE_PATH_RE } from "../llm/verification-target-guard.js";
import type { HookDispatcher } from './hooks.js';
import type { ApprovalEffectRef, ApprovalEngine } from './approvals.js';
import {
  EXECUTE_WITH_AGENT_TOOL_NAME,
} from './delegation-tool.js';
import { COORDINATOR_MODE_TOOL_NAME } from "./coordinator-tool.js";
import { executeCoordinatorModeTool } from "./tool-handler-factory-coordinator.js";
import {
  isSubAgentSessionId,
  type DelegationToolCompositionResolver,
} from './delegation-runtime.js';
import { executeDelegationTool } from "./tool-handler-factory-delegation.js";
import type { PolicyEvaluationScope } from "../policy/types.js";
import type { SessionCredentialBroker } from "../policy/session-credentials.js";
import { type ArtifactAccessMode } from "../workflow/artifact-contract.js";
import { buildCompensationState, captureFilesystemSnapshot } from "../workflow/compensation.js";
import type { EffectLedger } from "../workflow/effect-ledger.js";
import {
  buildEffectIntentSummary,
  inferEffectClass,
  inferEffectKind,
  isMutatingTool,
  type EffectRecord,
  type EffectTarget,
} from "../workflow/effects.js";
import { deriveEffectIdempotencyKey, getCurrentEffectExecutionContext } from "../workflow/idempotency.js";
import {
  isPathWithinAnyRoot,
  isPathWithinRoot,
  normalizeEnvelopePath,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import {
  resolveExecutionEnvelopeArtifactRelations,
  type ExecutionEnvelope,
} from "../workflow/execution-envelope.js";
import type { RuntimeContractFlags } from "../runtime-contract/types.js";
import type { RuntimeIncidentDiagnostics } from "../telemetry/incident-diagnostics.js";
import {
  FaultInjectionError,
  type RuntimeFaultInjector,
} from "../eval/fault-injection.js";

const DESKTOP_GUI_LAUNCH_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const DESKTOP_TERMINAL_LAUNCH_RE = /\b(?:xfce4-terminal|gnome-terminal|xterm|kitty)\b/i;
const DESKTOP_BROWSER_LAUNCH_RE = /\b(?:firefox|chromium|chromium-browser|google-chrome)\b/i;
const DESKTOP_FILE_MANAGER_LAUNCH_RE = /\b(?:thunar|nautilus)\b/i;
const DESKTOP_EDITOR_LAUNCH_RE = /\b(?:mousepad|gedit)\b/i;
const COLLAPSE_WHITESPACE_RE = /\s+/g;
const APPROVAL_TASK_PREVIEW_MAX_CHARS = 180;
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  "system.makeDir": "system.mkdir",
  "system.listFiles": "system.listDir",
};
const TOOL_DEFAULT_CWD_NAMES = new Set([
  "system.bash",
  "desktop.bash",
  "system.processStart",
  "system.serverStart",
  "verification.listProbes",
  "verification.runProbe",
  "system.grep",
  "system.glob",
  "system.searchFiles",
  "system.repoInventory",
  "system.gitStatus",
  "system.gitDiff",
  "system.gitShow",
  "system.gitBranchInfo",
  "system.gitChangeSummary",
  "system.gitWorktreeList",
  "system.gitWorktreeCreate",
  "system.gitWorktreeRemove",
  "system.symbolSearch",
  "system.symbolDefinition",
  "system.symbolReferences",
]);
const SESSION_ALLOWED_ROOT_TOOL_NAMES = new Set([
  "system.readFile",
  "system.readFileRange",
  "system.writeFile",
  "system.appendFile",
  "system.editFile",
  "system.grep",
  "system.glob",
  "system.searchFiles",
  "system.repoInventory",
  "system.gitStatus",
  "system.gitDiff",
  "system.gitShow",
  "system.gitBranchInfo",
  "system.gitChangeSummary",
  "system.gitWorktreeList",
  "system.gitWorktreeCreate",
  "system.gitWorktreeRemove",
  "system.gitWorktreeStatus",
  "system.applyPatch",
  "system.symbolSearch",
  "system.symbolDefinition",
  "system.symbolReferences",
  "system.listDir",
  "system.stat",
  "system.mkdir",
  "system.delete",
  "system.move",
  "system.pdfInfo",
  "system.pdfExtractText",
  "system.officeDocumentInfo",
  "system.officeDocumentExtractText",
  "system.emailMessageInfo",
  "system.emailMessageExtractText",
  "system.calendarInfo",
  "system.calendarRead",
  "system.sqliteSchema",
  "system.sqliteQuery",
  "system.spreadsheetInfo",
  "system.spreadsheetRead",
]);

/**
 * Filesystem tool names that need a session-scoped readFileState entry
 * for the Read-before-Write rule. The gateway injects `SESSION_ID_ARG`
 * into the args of every call to one of these tools so the per-session
 * read tracker in `runtime/src/tools/system/filesystem.ts` and the
 * desktop text editor adapter can record and validate which paths the
 * model has seen in the current chat session.
 */
const SESSION_ID_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.readFile",
  "system.readFileRange",
  "system.writeFile",
  "system.appendFile",
  "system.editFile",
  "system.applyPatch",
]);
const TOOL_PATH_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  "desktop.text_editor": ["path"],
  "system.readFile": ["path"],
  "system.readFileRange": ["path"],
  "system.writeFile": ["path"],
  "system.appendFile": ["path"],
  "system.editFile": ["path"],
  "system.grep": ["path"],
  "system.glob": ["path"],
  "system.searchFiles": ["path"],
  "system.repoInventory": ["path"],
  "system.gitStatus": ["path"],
  "system.gitDiff": ["path"],
  "system.gitShow": ["path"],
  "system.gitBranchInfo": ["path"],
  "system.gitChangeSummary": ["path"],
  "system.gitWorktreeList": ["path"],
  "system.gitWorktreeCreate": ["path", "worktreePath"],
  "system.gitWorktreeRemove": ["path", "worktreePath"],
  "system.gitWorktreeStatus": ["worktreePath"],
  "system.applyPatch": ["path"],
  "system.symbolSearch": ["path"],
  "system.symbolDefinition": ["path", "filePath"],
  "system.symbolReferences": ["path", "filePath"],
  "system.listDir": ["path"],
  "system.stat": ["path"],
  "system.mkdir": ["path"],
  "system.delete": ["path"],
  "system.move": ["source", "destination"],
  "system.pdfInfo": ["path"],
  "system.pdfExtractText": ["path"],
  "system.officeDocumentInfo": ["path"],
  "system.officeDocumentExtractText": ["path"],
  "system.emailMessageInfo": ["path"],
  "system.emailMessageExtractText": ["path"],
  "system.calendarInfo": ["path"],
  "system.calendarRead": ["path"],
  "system.sqliteSchema": ["path"],
  "system.sqliteQuery": ["path"],
  "system.spreadsheetInfo": ["path"],
  "system.spreadsheetRead": ["path"],
};
const READ_ONLY_FILESYSTEM_TOOL_NAMES = new Set([
  "system.readFile",
  "system.listDir",
  "system.stat",
  "system.pdfInfo",
  "system.pdfExtractText",
  "system.officeDocumentInfo",
  "system.officeDocumentExtractText",
  "system.emailMessageInfo",
  "system.emailMessageExtractText",
  "system.calendarInfo",
  "system.calendarRead",
  "system.sqliteSchema",
  "system.sqliteQuery",
  "system.spreadsheetInfo",
  "system.spreadsheetRead",
]);
const WRITE_FILESYSTEM_TOOL_MODES: Readonly<Record<string, ArtifactAccessMode>> = {
  "desktop.text_editor": "write",
  "system.writeFile": "write",
  "system.appendFile": "append",
  "system.editFile": "write",
  "system.mkdir": "mkdir",
  "system.delete": "write",
  "system.move": "write",
};
const ABSOLUTE_PATH_ARG_RE = /^(?:~\/|\/)/;
const HEAD_TAIL_OPTION_VALUE_FLAGS = new Set([
  "-c",
  "-n",
  "--bytes",
  "--lines",
]);
const GREP_OPTION_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--context",
  "--directories",
  "--max-count",
  "--regexp",
  "--file",
]);
const SED_OPTION_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "--expression",
  "--file",
]);
const WORKSPACE_ALIAS_ROOT = "/workspace";
const BEHAVIOR_COMMAND_RE =
  /\b(?:test|tests|vitest|jest|pytest|playwright|ctest|cargo test|go test|smoke|scenario|e2e|end-to-end)\b/i;
const BUILD_COMMAND_RE =
  /\b(?:build|compile|compiled|typecheck|lint|tsc|cmake|make(?:\s+test)?|cargo build|npm run build|pnpm build|yarn build)\b/i;

interface VerificationResultMetadata {
  readonly category: "build" | "behavior" | "review";
  readonly repoLocal?: boolean;
  readonly generatedHarness?: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly path?: string;
}

function normalizeToolName(name: string): string {
  const alias = TOOL_NAME_ALIASES[name];
  return typeof alias === "string" ? alias : name;
}

function stripInternalToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const hasAllowedRoots = SESSION_ALLOWED_ROOTS_ARG in args;
  const hasTaskListId = TASK_LIST_ARG in args;
  const hasTaskActorKind = TASK_ACTOR_KIND_ARG in args;
  const hasTaskActorName = TASK_ACTOR_NAME_ARG in args;
  const hasSessionId = SESSION_ID_ARG in args;
  const hasAdvertisedToolNames = SESSION_ADVERTISED_TOOL_NAMES_ARG in args;
  if (
    !hasAllowedRoots &&
    !hasTaskListId &&
    !hasTaskActorKind &&
    !hasTaskActorName &&
    !hasSessionId &&
    !hasAdvertisedToolNames
  ) {
    return args;
  }
  const nextArgs = { ...args };
  if (hasAllowedRoots) {
    delete nextArgs[SESSION_ALLOWED_ROOTS_ARG];
  }
  if (hasTaskListId) {
    delete nextArgs[TASK_LIST_ARG];
  }
  if (hasTaskActorKind) {
    delete nextArgs[TASK_ACTOR_KIND_ARG];
  }
  if (hasTaskActorName) {
    delete nextArgs[TASK_ACTOR_NAME_ARG];
  }
  if (hasSessionId) {
    delete nextArgs[SESSION_ID_ARG];
  }
  if (hasAdvertisedToolNames) {
    delete nextArgs[SESSION_ADVERTISED_TOOL_NAMES_ARG];
  }
  return nextArgs;
}

function applySessionTaskListId(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): Record<string, unknown> {
  if (!TASK_TRACKER_TOOL_NAMES.has(toolName)) {
    return args;
  }
  if (!sessionId || sessionId.trim().length === 0) {
    return args;
  }
  return {
    ...args,
    [TASK_LIST_ARG]: sessionId,
  };
}

function applyTaskActorContext(
  toolName: string,
  args: Record<string, unknown>,
  isSubAgentSession: boolean,
  subAgentInfo: DelegationSubAgentInfo,
): Record<string, unknown> {
  if (!TASK_TRACKER_TOOL_NAMES.has(toolName)) {
    return args;
  }
  const actorName =
    isSubAgentSession
      ? subAgentInfo?.role?.trim() || subAgentInfo?.sessionId?.trim()
      : undefined;
  return {
    ...args,
    [TASK_ACTOR_KIND_ARG]: isSubAgentSession ? "subagent" : "main",
    ...(actorName ? { [TASK_ACTOR_NAME_ARG]: actorName } : {}),
  };
}

function applySessionAllowedRoots(
  toolName: string,
  args: Record<string, unknown>,
  additionalAllowedPaths: readonly string[] | undefined,
): Record<string, unknown> {
  if (
    !SESSION_ALLOWED_ROOT_TOOL_NAMES.has(toolName) ||
    !additionalAllowedPaths ||
    additionalAllowedPaths.length === 0
  ) {
    return args;
  }
  return {
    ...args,
    [SESSION_ALLOWED_ROOTS_ARG]: [...additionalAllowedPaths],
  };
}

/**
 * Inject the chat session ID into the args of filesystem tools that
 * participate in the Read-before-Write rule. The injected value is
 * consumed by the per-session readFileState map in
 * `runtime/src/tools/system/filesystem.ts` and stripped from any
 * user-visible serialization by `stripInternalToolArgs`.
 */
function applySessionId(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): Record<string, unknown> {
  if (!SESSION_ID_TOOL_NAMES.has(toolName)) {
    return args;
  }
  if (!sessionId || sessionId.trim().length === 0) {
    return args;
  }
  return {
    ...args,
    [SESSION_ID_ARG]: sessionId,
  };
}

function applyAdvertisedToolNames(
  toolName: string,
  args: Record<string, unknown>,
  availableToolNames: readonly string[] | undefined,
): Record<string, unknown> {
  if (toolName !== "system.searchTools" || !availableToolNames) {
    return args;
  }
  return {
    ...args,
    [SESSION_ADVERTISED_TOOL_NAMES_ARG]: [...availableToolNames],
  };
}

function deriveSessionAllowedPaths(params: {
  readonly explicitAdditionalAllowedPaths?: readonly string[];
  readonly scopedFilesystemRoot?: string;
  readonly defaultWorkingDirectory?: string;
}): readonly string[] | undefined {
  const candidates = [
    ...(params.explicitAdditionalAllowedPaths ?? []),
    params.scopedFilesystemRoot,
    params.defaultWorkingDirectory,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => resolvePath(value.trim()).normalize("NFC"));
  if (candidates.length === 0) {
    return undefined;
  }
  return Array.from(new Set(candidates));
}

function isRelativeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return false;
  }
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
}

function pathExists(candidatePath: string): boolean {
  try {
    return existsSync(candidatePath);
  } catch {
    return false;
  }
}

function referencesAbsolutePathWithinRoot(
  toolName: string,
  args: Record<string, unknown>,
  rootPath: string,
): boolean {
  const normalizedRoot = normalizeScopedPathCandidate(rootPath);
  if ((toolName === "system.bash" || toolName === "desktop.bash")) {
    if (Array.isArray(args.args)) {
      for (const arg of extractDirectCommandPathArgs(args.command, args.args)) {
        const candidatePath = normalizeScopedPathCandidate(arg);
        if (isWithinRoot(normalizedRoot, candidatePath)) {
          return true;
        }
      }
    } else if (typeof args.command === "string") {
      for (const pathValue of extractAbsoluteShellPaths(args.command)) {
        const candidatePath = normalizeScopedPathCandidate(pathValue);
        if (isWithinRoot(normalizedRoot, candidatePath)) {
          return true;
        }
      }
    }
  }

  return false;
}

function extractNonOptionOperands(
  args: readonly unknown[],
  optionValueFlags: ReadonlySet<string> = new Set(),
): string[] {
  const matches: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (trimmed.length === 0) continue;
    if (optionValueFlags.has(trimmed)) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("-")) {
      continue;
    }
    matches.push(trimmed);
  }
  return matches;
}

function extractSedTargetArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index += 1;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index += 1;
      continue;
    }
    if (SED_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index += 1;
      continue;
    }
    index += 1;
    break;
  }
  return args
    .slice(index)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function extractGrepTargetArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index += 1;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index += 1;
      continue;
    }
    if (GREP_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index += 1;
      continue;
    }
    index += 1;
    break;
  }
  return args
    .slice(index)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function extractExplicitFilesystemTargets(
  command: unknown,
  args: readonly unknown[],
): string[] {
  const commandName = typeof command === "string"
    ? command.trim().replace(/^.*[\\/]/, "").toLowerCase()
    : "";
  switch (commandName) {
    case "sed":
      return extractSedTargetArgs(args);
    case "grep":
      return extractGrepTargetArgs(args);
    case "head":
    case "tail":
      return extractNonOptionOperands(args, HEAD_TAIL_OPTION_VALUE_FLAGS);
    case "ls":
    case "cat":
    case "wc":
    case "mkdir":
    case "rm":
    case "mv":
    case "cp":
    case "touch":
    case "install":
    case "find":
      return extractNonOptionOperands(args);
    default:
      return [];
  }
}

function isFilesystemRedirectionOperator(value: string): boolean {
  return isShellRedirectionOperator(value) && !value.includes("<<");
}

function referencesExplicitFilesystemTarget(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return false;
  }

  if (Array.isArray(args.args)) {
    return extractExplicitFilesystemTargets(args.command, args.args).length > 0;
  }

  if (typeof args.command !== "string") {
    return false;
  }

  const tokens = tokenizeShellCommand(args.command);
  let currentCommandName: string | undefined;
  let currentArgs: string[] = [];

  const flushCurrentCommand = (): boolean => {
    if (!currentCommandName) {
      currentArgs = [];
      return false;
    }
    const hasFilesystemTarget =
      extractExplicitFilesystemTargets(currentCommandName, currentArgs).length > 0;
    currentCommandName = undefined;
    currentArgs = [];
    return hasFilesystemTarget;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "operator") {
      if (isShellCommandBoundaryOperator(token.value)) {
        if (flushCurrentCommand()) {
          return true;
        }
        continue;
      }
      if (isFilesystemRedirectionOperator(token.value)) {
        const next = tokens[index + 1];
        if (next?.type === "word" && next.value.trim().length > 0) {
          return true;
        }
      }
      continue;
    }

    const value = token.value.trim();
    if (value.length === 0) continue;
    if (!currentCommandName) {
      if (isShellVariableAssignment(value)) {
        continue;
      }
      currentCommandName = value;
      continue;
    }
    currentArgs.push(value);
  }

  return flushCurrentCommand();
}

interface DefaultWorkingDirectoryApplication {
  readonly args: Record<string, unknown>;
  readonly missingDefaultWorkingDirectory?: {
    readonly path: string;
    readonly bootstrapPermitted: boolean;
  };
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveToolTargetPaths(
  toolName: string,
  args: Record<string, unknown>,
  defaultWorkingDirectory?: string,
): string[] {
  const pathKeys = TOOL_PATH_ARG_KEYS[toolName] ?? [];
  if (pathKeys.length === 0) {
    return [];
  }
  const resolved = new Set<string>();
  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    resolved.add(resolveFilesystemToolPath(value.trim(), args, defaultWorkingDirectory));
  }
  return [...resolved];
}

function buildEffectTargets(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly defaultWorkingDirectory?: string;
  readonly executionContext?: {
    readonly targetArtifacts?: readonly string[];
  };
}): EffectTarget[] {
  const filesystemTargets = resolveToolTargetPaths(
    params.toolName,
    params.args,
    params.defaultWorkingDirectory,
  ).map((path) => ({ kind: "path" as const, path }));
  if (filesystemTargets.length > 0) {
    return filesystemTargets;
  }

  if (params.toolName === "system.processStart") {
    return [
      {
        kind: "process",
        label:
          typeof params.args.label === "string" ? params.args.label : undefined,
        command:
          typeof params.args.command === "string"
            ? params.args.command
            : undefined,
        cwd:
          typeof params.args.cwd === "string" ? params.args.cwd : undefined,
      },
    ];
  }

  if (params.toolName === "system.serverStart") {
    return [
      {
        kind: "server",
        label:
          typeof params.args.label === "string" ? params.args.label : undefined,
        command:
          typeof params.args.command === "string"
            ? params.args.command
            : undefined,
        cwd:
          typeof params.args.cwd === "string" ? params.args.cwd : undefined,
      },
    ];
  }

  if (params.toolName === "system.bash" || params.toolName === "desktop.bash") {
    const command =
      typeof params.args.command === "string"
        ? params.args.command
        : Array.isArray(params.args.args)
          ? [params.args.command, ...params.args.args].join(" ")
          : undefined;
    const explicitTargetArtifacts =
      params.executionContext?.targetArtifacts?.map((path) => ({
        kind: "path" as const,
        path,
      })) ?? [];
    return [
      ...explicitTargetArtifacts,
      {
        kind: "command",
        command,
        cwd:
          typeof params.args.cwd === "string"
            ? params.args.cwd
            : params.defaultWorkingDirectory,
      },
    ];
  }

  return [
    {
      kind: "command",
      command: params.toolName,
    },
  ];
}

function serializeEffectSnapshots(
  snapshots: readonly NonNullable<EffectRecord["preExecutionSnapshots"]>[number][] | undefined,
): readonly Record<string, unknown>[] | undefined {
  if (!snapshots || snapshots.length === 0) {
    return undefined;
  }
  return snapshots.map((snapshot) => ({
    path: snapshot.path,
    exists: snapshot.exists,
    entryType: snapshot.entryType,
    ...(typeof snapshot.sizeBytes === "number"
      ? { sizeBytes: snapshot.sizeBytes }
      : {}),
    ...(typeof snapshot.sha256 === "string" ? { sha256: snapshot.sha256 } : {}),
  }));
}

function buildEffectResultMetadata(
  effectRecord: EffectRecord,
): Record<string, unknown> {
  return {
    __agencEffect: {
      id: effectRecord.id,
      idempotencyKey: effectRecord.idempotencyKey,
      kind: effectRecord.kind,
      effectClass: effectRecord.effectClass,
      status: effectRecord.status,
      targets: effectRecord.targets,
      ...(serializeEffectSnapshots(effectRecord.preExecutionSnapshots)
        ? { preExecutionSnapshots: serializeEffectSnapshots(effectRecord.preExecutionSnapshots) }
        : {}),
      ...(serializeEffectSnapshots(effectRecord.postExecutionSnapshots)
        ? { postExecutionSnapshots: serializeEffectSnapshots(effectRecord.postExecutionSnapshots) }
        : {}),
      ...(effectRecord.result ? { result: effectRecord.result } : {}),
    },
  };
}

function buildVerificationResultMetadata(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly defaultWorkingDirectory?: string;
  readonly scopedFilesystemRoot?: string;
}): Record<string, unknown> | undefined {
  const normalizedRoots = normalizeEnvelopeRoots([
    params.scopedFilesystemRoot,
    params.defaultWorkingDirectory,
  ]);
  const toolName = params.toolName.trim();

  if (toolName === "system.bash" || toolName === "desktop.bash") {
    const invocation = collectShellCommandInvocation(params.args);
    const category = classifyVerificationCommand(invocation);
    if (!category) {
      return undefined;
    }
    const cwd =
      typeof params.args.cwd === "string" && params.args.cwd.trim().length > 0
        ? normalizeEnvelopePath(params.args.cwd, params.defaultWorkingDirectory)
        : params.defaultWorkingDirectory;
    return {
      __agencVerification: {
        category,
        ...(typeof cwd === "string" && cwd.trim().length > 0 ? { cwd } : {}),
        ...(invocation.commandText ? { command: invocation.commandText } : {}),
        ...(cwd && isPathWithinAnyRoot(cwd, normalizedRoots)
          ? { repoLocal: true }
          : {}),
      },
    };
  }

  if (
    toolName === "system.writeFile" ||
    toolName === "system.appendFile" ||
    toolName === "desktop.text_editor"
  ) {
    const rawPath =
      typeof params.args.path === "string" ? params.args.path : undefined;
    if (!rawPath || !TEST_FILE_PATH_RE.test(rawPath)) {
      return undefined;
    }
    const path = normalizeEnvelopePath(rawPath, params.defaultWorkingDirectory);
    return {
      __agencVerification: {
        category: "behavior",
        generatedHarness: true,
        path,
        ...(isPathWithinAnyRoot(path, normalizedRoots)
          ? { repoLocal: true }
          : {}),
      },
    };
  }

  return undefined;
}

function collectShellCommandInvocation(args: Record<string, unknown>): {
  readonly commandText: string;
  readonly executable: string;
  readonly argvText: string;
} {
  const parts: string[] = [];
  let executable = "";
  if (typeof args.command === "string" && args.command.trim().length > 0) {
    executable = args.command.trim();
    parts.push(executable);
  }
  if (Array.isArray(args.args)) {
    for (const entry of args.args) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        parts.push(entry.trim());
      }
    }
  }
  return {
    commandText: parts.join(" ").trim(),
    executable: executable.toLowerCase(),
    argvText: parts.slice(1).join(" ").toLowerCase(),
  };
}

function classifyVerificationCommand(
  invocation: {
    readonly executable: string;
    readonly argvText: string;
  },
): VerificationResultMetadata["category"] | undefined {
  if (!invocation.executable) {
    return undefined;
  }
  if (
    ["vitest", "jest", "pytest", "playwright", "ctest"].includes(
      invocation.executable,
    ) ||
    (
      ["npm", "pnpm", "yarn", "cargo", "go", "make"].includes(
        invocation.executable,
      ) &&
      BEHAVIOR_COMMAND_RE.test(invocation.argvText)
    )
  ) {
    return "behavior";
  }
  if (
    ["tsc", "cmake"].includes(invocation.executable) ||
    (
      ["npm", "pnpm", "yarn", "cargo", "go", "make"].includes(
        invocation.executable,
      ) &&
      BUILD_COMMAND_RE.test(invocation.argvText)
    )
  ) {
    return "build";
  }
  return undefined;
}

function buildApprovalEffectRef(params: {
  readonly effectId: string;
  readonly effectIdempotencyKey: string;
  readonly toolName: string;
  readonly targets: readonly EffectTarget[];
  readonly effectClass: string;
  readonly effectKind: string;
  readonly compensationAvailable: boolean;
  readonly preExecutionSnapshots?: readonly {
    readonly path: string;
    readonly exists: boolean;
    readonly entryType: import("../workflow/effects.js").EffectFilesystemEntryType;
  }[];
}): ApprovalEffectRef {
  return {
    effectId: params.effectId,
    idempotencyKey: params.effectIdempotencyKey,
    effectClass: params.effectClass,
    effectKind: params.effectKind,
    summary: buildEffectIntentSummary({
      toolName: params.toolName,
      targets: params.targets,
    }),
    compensationAvailable: params.compensationAvailable,
    targets: params.targets
      .map((target) => target.path ?? target.command ?? target.label)
      .filter((value): value is string => typeof value === "string"),
    ...(params.preExecutionSnapshots && params.preExecutionSnapshots.length > 0
      ? { preExecutionSnapshots: params.preExecutionSnapshots }
      : {}),
  };
}

function resolveFilesystemToolPath(
  rawPath: string,
  args: Record<string, unknown>,
  defaultWorkingDirectory?: string,
): string {
  const cwd = typeof args.cwd === "string" && args.cwd.trim().length > 0
    ? args.cwd.trim()
    : defaultWorkingDirectory?.trim();
  return normalizeEnvelopePath(rawPath, cwd);
}

function getFilesystemToolAccessMode(
  toolName: string,
): ArtifactAccessMode | undefined {
  if (READ_ONLY_FILESYSTEM_TOOL_NAMES.has(toolName)) {
    return "read";
  }
  return WRITE_FILESYSTEM_TOOL_MODES[toolName];
}

function enforceSubAgentExecutionEnvelope(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly executionContext?: ExecutionEnvelope;
  readonly defaultWorkingDirectory?: string;
}): string | undefined {
  const { executionContext } = params;
  if (!executionContext) return undefined;

  const mode = getFilesystemToolAccessMode(params.toolName);
  if (!mode) return undefined;

  const pathKeys = TOOL_PATH_ARG_KEYS[params.toolName] ?? [];
  if (pathKeys.length === 0) return undefined;

  // Audit S1.6: normalize so the filesystem-effect handler enforces
  // allowed-roots membership against the same canonical root that
  // verifier and contract guidance use.
  const workspaceRoot =
    normalizeWorkspaceRoot(executionContext.workspaceRoot) ?? params.defaultWorkingDirectory;
  const readRoots = normalizeEnvelopeRoots(
    executionContext.allowedReadRoots ?? [],
    workspaceRoot,
  );
  const writeRoots = normalizeEnvelopeRoots(
    executionContext.allowedWriteRoots ?? [],
    workspaceRoot,
  );
  const explicitlyWritableArtifacts = collectExplicitWritableExecutionArtifacts(
    executionContext,
    workspaceRoot,
  );

  for (const key of pathKeys) {
    const rawValue = params.args[key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    const resolvedPath = resolveFilesystemToolPath(
      rawValue,
      params.args,
      workspaceRoot,
    );
    const allowedRoots = mode === "read" ? readRoots : writeRoots;
    if (allowedRoots.length > 0 && !isPathWithinAnyRoot(resolvedPath, allowedRoots)) {
      return `Delegated ${mode} path "${resolvedPath}" is outside the execution envelope roots`;
    }
    if (
      mode !== "read" &&
      isRepoLocalVerificationHarnessPath(resolvedPath, workspaceRoot) &&
      !explicitlyWritableArtifacts.some((artifactPath) =>
        artifactPath === resolvedPath || isPathWithinRoot(resolvedPath, artifactPath)
      )
    ) {
      return `Delegated ${mode} path "${resolvedPath}" rewrites a repo-local verification harness without explicitly owning it as a writable target`;
    }
  }

  return undefined;
}

function collectExplicitWritableExecutionArtifacts(
  executionContext: NonNullable<
    Parameters<typeof enforceSubAgentExecutionEnvelope>[0]["executionContext"]
  >,
  workspaceRoot?: string,
): readonly string[] {
  const normalizedWorkspaceRoot =
    typeof workspaceRoot === "string" ? normalizeEnvelopePath(workspaceRoot) : "";
  const explicitArtifacts = new Set<string>();
  const addArtifact = (value: string | undefined): void => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    const normalized = normalizeEnvelopePath(value, workspaceRoot);
    if (!normalized || normalized === normalizedWorkspaceRoot) {
      return;
    }
    explicitArtifacts.add(normalized);
  };

  for (const artifact of executionContext.targetArtifacts ?? []) {
    addArtifact(artifact);
  }
  for (const relation of resolveExecutionEnvelopeArtifactRelations(
    executionContext,
  )) {
    if (relation.relationType !== "write_owner") {
      continue;
    }
    addArtifact(relation.artifactPath);
  }

  return [...explicitArtifacts];
}

function isRepoLocalVerificationHarnessPath(
  path: string,
  workspaceRoot?: string,
): boolean {
  if (!workspaceRoot || !isPathWithinRoot(path, workspaceRoot)) {
    return false;
  }
  const relativePath = relative(workspaceRoot, path).replace(/\\/gu, "/");
  if (relativePath.startsWith("../")) {
    return false;
  }
  return (
    /(?:^|\/)(?:test|tests|spec|specs|__tests__)\/.+\.(?:sh|bash|zsh)$/iu.test(
      relativePath,
    ) ||
    /(?:^|\/)(?:run|verify|smoke|integration|e2e)[-_]?tests?\.(?:sh|bash|zsh)$/iu
      .test(relativePath)
  );
}

function applyDefaultWorkingDirectory(
  toolName: string,
  args: Record<string, unknown>,
  defaultWorkingDirectory?: string,
): DefaultWorkingDirectoryApplication {
  const workingDirectory = defaultWorkingDirectory?.trim();
  if (!workingDirectory) {
    return { args };
  }

  let nextArgs = args;
  const cwdValue = typeof nextArgs.cwd === "string"
    ? nextArgs.cwd.trim()
    : undefined;
  const hasExplicitCwd = typeof cwdValue === "string" && cwdValue.length > 0;
  const logicalWorkingDirectory = cwdValue && isRelativeLocalPath(cwdValue)
    ? resolvePath(workingDirectory, cwdValue)
    : (cwdValue ?? workingDirectory);
  const shouldInjectDefaultCwd = TOOL_DEFAULT_CWD_NAMES.has(toolName);
  let executionWorkingDirectory: string | undefined = logicalWorkingDirectory;
  let missingDefaultWorkingDirectory:
    | DefaultWorkingDirectoryApplication["missingDefaultWorkingDirectory"]
    | undefined;

  if (
    shouldInjectDefaultCwd &&
    !hasExplicitCwd &&
    !pathExists(logicalWorkingDirectory)
  ) {
    executionWorkingDirectory = undefined;
    missingDefaultWorkingDirectory = {
      path: logicalWorkingDirectory,
      bootstrapPermitted:
        referencesAbsolutePathWithinRoot(
          toolName,
          nextArgs,
          logicalWorkingDirectory,
        ) || referencesExplicitFilesystemTarget(toolName, nextArgs),
    };
  }

  if (
    shouldInjectDefaultCwd &&
    typeof executionWorkingDirectory === "string" &&
    nextArgs.cwd !== executionWorkingDirectory
  ) {
    nextArgs = { ...nextArgs, cwd: executionWorkingDirectory };
  }

  const workspaceRootValue =
    typeof nextArgs.workspaceRoot === "string"
      ? nextArgs.workspaceRoot.trim()
      : undefined;
  if (workspaceRootValue && typeof logicalWorkingDirectory === "string") {
    const normalizedWorkspaceRoot = normalizeEnvelopePath(
      workspaceRootValue,
      logicalWorkingDirectory,
    );
    if (normalizedWorkspaceRoot !== workspaceRootValue) {
      if (nextArgs === args) {
        nextArgs = { ...nextArgs };
      }
      nextArgs.workspaceRoot = normalizedWorkspaceRoot;
    }
  }

  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (!pathArgKeys) {
    return {
      args: nextArgs,
      ...(missingDefaultWorkingDirectory
        ? { missingDefaultWorkingDirectory }
        : {}),
    };
  }

  for (const key of pathArgKeys) {
    const value = nextArgs[key];
    if (typeof value !== "string" || !isRelativeLocalPath(value)) {
      continue;
    }
    if (nextArgs === args) {
      nextArgs = { ...nextArgs };
    }
    nextArgs[key] = resolvePath(logicalWorkingDirectory, value);
  }

  return {
    args: nextArgs,
    ...(missingDefaultWorkingDirectory
      ? { missingDefaultWorkingDirectory }
      : {}),
  };
}

function buildMissingDefaultWorkingDirectoryError(
  path: string,
  bootstrapPermitted: boolean,
): string {
  if (bootstrapPermitted) {
    return (
      `Delegated working directory "${path}" does not exist yet, so no default cwd was injected. ` +
      "Retry with an existing cwd or keep targeting that workspace via absolute paths until it exists."
    );
  }
  return (
    `Delegated working directory "${path}" does not exist yet. ` +
    "Create it first with system.mkdir or retry the command with an existing cwd."
  );
}

function expandHomeDirectory(rawPath: string): string {
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~\\")
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home || home.trim().length === 0) return rawPath;
    if (rawPath === "~") return home;
    return `${home}${rawPath.slice(1)}`;
  }
  return rawPath;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeScopedPathCandidate(rawPath: string): string {
  return resolvePath(expandHomeDirectory(rawPath.trim()));
}

function hasWorkspaceAliasPath(rawPath: string): boolean {
  return rawPath === WORKSPACE_ALIAS_ROOT ||
    rawPath.startsWith(`${WORKSPACE_ALIAS_ROOT}/`);
}

function translateWorkspaceAliasPath(
  rawPath: string,
  workspaceRoot?: string,
): string {
  const trimmed = rawPath.trim();
  if (!hasWorkspaceAliasPath(trimmed)) {
    return rawPath;
  }
  const root = workspaceRoot?.trim();
  if (!root || root === WORKSPACE_ALIAS_ROOT) {
    return rawPath;
  }
  const normalizedRoot = normalizeScopedPathCandidate(root);
  if (hasWorkspaceAliasPath(normalizedRoot)) {
    return rawPath;
  }
  if (normalizedRoot === "/") {
    return rawPath;
  }
  const relativePath = trimmed
    .slice(WORKSPACE_ALIAS_ROOT.length)
    .replace(/^\/+/, "");
  return relativePath.length > 0
    ? resolvePath(normalizedRoot, relativePath)
    : normalizedRoot;
}

function rewriteWorkspaceAliasShellCommand(
  command: string,
  workspaceRoot?: string,
): string {
  const replacements = [...extractAbsoluteShellPaths(command)]
    .map((value) => ({
      from: value,
      to: translateWorkspaceAliasPath(value, workspaceRoot),
    }))
    .filter((entry) => entry.from !== entry.to)
    .sort((left, right) => right.from.length - left.from.length);

  let rewritten = command;
  for (const entry of replacements) {
    rewritten = rewritten.split(entry.from).join(entry.to);
  }
  return rewritten;
}

function applyWorkspaceAliasTranslation(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): Record<string, unknown> {
  const root = workspaceRoot?.trim();
  if (!root || root === WORKSPACE_ALIAS_ROOT) {
    return args;
  }

  let nextArgs = args;
  const updateArg = (key: string, nextValue: unknown): void => {
    if (nextArgs === args) {
      nextArgs = { ...args };
    }
    nextArgs[key] = nextValue;
  };

  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (pathArgKeys) {
    for (const key of pathArgKeys) {
      const value = nextArgs[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      const translated = translateWorkspaceAliasPath(value, root);
      if (translated !== value) {
        updateArg(key, translated);
      }
    }
  }

  const cwdValue = typeof nextArgs.cwd === "string"
    ? nextArgs.cwd.trim()
    : undefined;
  if (cwdValue) {
    const translatedCwd = translateWorkspaceAliasPath(cwdValue, root);
    if (translatedCwd !== cwdValue) {
      updateArg("cwd", translatedCwd);
    }
  }

  const workspaceRootValue =
    typeof nextArgs.workspaceRoot === "string"
      ? nextArgs.workspaceRoot.trim()
      : undefined;
  if (workspaceRootValue) {
    const translatedWorkspaceRoot = translateWorkspaceAliasPath(
      workspaceRootValue,
      root,
    );
    if (translatedWorkspaceRoot !== workspaceRootValue) {
      updateArg("workspaceRoot", translatedWorkspaceRoot);
    }
  }

  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return nextArgs;
  }

  const commandValue = typeof nextArgs.command === "string"
    ? nextArgs.command
    : undefined;
  if (commandValue && !Array.isArray(nextArgs.args)) {
    const translatedCommand = rewriteWorkspaceAliasShellCommand(
      commandValue,
      root,
    );
    if (translatedCommand !== commandValue) {
      updateArg("command", translatedCommand);
    }
    return nextArgs;
  }

  if (commandValue) {
    const translatedCommand = translateWorkspaceAliasPath(commandValue, root);
    if (translatedCommand !== commandValue) {
      updateArg("command", translatedCommand);
    }
  }

  if (!Array.isArray(nextArgs.args)) {
    return nextArgs;
  }

  const pathArgs = new Set(
    extractDirectCommandPathArgs(nextArgs.command, nextArgs.args).map((value) =>
      value.trim()
    ),
  );
  if (pathArgs.size === 0) {
    return nextArgs;
  }

  let didRewriteArgs = false;
  const translatedArgs = nextArgs.args.map((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    if (!pathArgs.has(trimmed)) {
      return value;
    }
    const translated = translateWorkspaceAliasPath(trimmed, root);
    if (translated === trimmed) {
      return value;
    }
    didRewriteArgs = true;
    return translated;
  });
  if (didRewriteArgs) {
    updateArg("args", translatedArgs);
  }

  return nextArgs;
}

function buildDelegatedWorkspaceAliasLeakError(detail: string): string {
  return (
    `Delegated tool execution requires canonical host paths before execution. ${detail}. ` +
    "Canonicalize /workspace aliases before the child session starts."
  );
}

function validateDelegatedCanonicalToolPaths(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (pathArgKeys) {
    for (const key of pathArgKeys) {
      const value = args[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      if (hasWorkspaceAliasPath(value.trim())) {
        return buildDelegatedWorkspaceAliasLeakError(
          `${key} still uses the logical /workspace alias (${value.trim()})`,
        );
      }
    }
  }

  const cwdValue = typeof args.cwd === "string" ? args.cwd.trim() : undefined;
  if (cwdValue && hasWorkspaceAliasPath(cwdValue)) {
    return buildDelegatedWorkspaceAliasLeakError(
      `cwd still uses the logical /workspace alias (${cwdValue})`,
    );
  }

  const workspaceRootValue =
    typeof args.workspaceRoot === "string"
      ? args.workspaceRoot.trim()
      : undefined;
  if (workspaceRootValue && hasWorkspaceAliasPath(workspaceRootValue)) {
    return buildDelegatedWorkspaceAliasLeakError(
      `workspaceRoot still uses the logical /workspace alias (${workspaceRootValue})`,
    );
  }

  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return undefined;
  }

  const commandValue = typeof args.command === "string"
    ? args.command.trim()
    : undefined;
  if (!commandValue) {
    return undefined;
  }
  for (const pathValue of extractAbsoluteShellPaths(commandValue)) {
    if (hasWorkspaceAliasPath(pathValue)) {
      return buildDelegatedWorkspaceAliasLeakError(
        `shell command references the logical /workspace alias (${pathValue})`,
      );
    }
  }

  if (!Array.isArray(args.args)) {
    return undefined;
  }
  for (const pathValue of extractDirectCommandPathArgs(args.command, args.args)) {
    if (hasWorkspaceAliasPath(pathValue.trim())) {
      return buildDelegatedWorkspaceAliasLeakError(
        `command arguments reference the logical /workspace alias (${pathValue.trim()})`,
      );
    }
  }

  return undefined;
}

type ShellToken =
  | { type: "word"; value: string }
  | { type: "operator"; value: string };

function tokenizeShellCommand(command: string): readonly ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let index = 0;
  let state: "normal" | "single" | "double" = "normal";

  const pushCurrent = (): void => {
    if (current.length === 0) return;
    tokens.push({ type: "word", value: current });
    current = "";
  };

  const pushOperator = (value: string): void => {
    tokens.push({ type: "operator", value });
  };

  while (index < command.length) {
    const ch = command[index]!;
    if (state === "single") {
      if (ch === "'") {
        state = "normal";
      } else {
        current += ch;
      }
      index += 1;
      continue;
    }

    if (state === "double") {
      if (ch === '"') {
        state = "normal";
        index += 1;
        continue;
      }
      if (ch === "\\" && index + 1 < command.length) {
        const next = command[index + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          index += 2;
          continue;
        }
      }
      current += ch;
      index += 1;
      continue;
    }

    if (ch === "'") {
      state = "single";
      index += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      index += 1;
      continue;
    }
    if (ch === "\\" && index + 1 < command.length) {
      current += command[index + 1]!;
      index += 2;
      continue;
    }
    if (ch === "\n") {
      pushCurrent();
      pushOperator("\n");
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      index += 1;
      continue;
    }

    if (ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") {
      let operator = ch;
      if ((ch === "<" || ch === ">") && /^\d+$/.test(current)) {
        operator = `${current}${ch}`;
        current = "";
      } else {
        pushCurrent();
      }

      const next = command[index + 1];
      if (ch === "|" && next === "|") {
        operator += next;
        index += 1;
      } else if (ch === "&" && (next === "&" || next === ">")) {
        operator += next;
        index += 1;
        if (operator === "&>" && command[index + 1] === ">") {
          operator += ">";
          index += 1;
        }
      } else if ((ch === "<" || ch === ">") && (next === ch || next === "&")) {
        operator += next;
        index += 1;
      }

      pushOperator(operator);
      index += 1;
      continue;
    }

    current += ch;
    index += 1;
  }

  pushCurrent();
  return tokens;
}

function isShellCommandBoundaryOperator(value: string): boolean {
  return value === "|" || value === "||" || value === "&&" || value === ";" || value === "&" || value === "\n";
}

function isShellRedirectionOperator(value: string): boolean {
  return /^(?:\d+)?(?:>>?|<<?|<>|>&|&>|&>>|<&)$/.test(value);
}

function isShellVariableAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

function extractAbsoluteShellPaths(command: string): readonly string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  const tokens = tokenizeShellCommand(command);
  let currentCommandName: string | undefined;
  let currentArgs: string[] = [];

  const pushPath = (value: string): void => {
    const trimmed = value.trim();
    if (!ABSOLUTE_PATH_ARG_RE.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    matches.push(trimmed);
  };

  const flushCurrentCommand = (): void => {
    if (!currentCommandName) {
      currentArgs = [];
      return;
    }
    for (const arg of extractDirectCommandPathArgs(currentCommandName, currentArgs)) {
      pushPath(arg);
    }
    currentCommandName = undefined;
    currentArgs = [];
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "operator") {
      if (isShellCommandBoundaryOperator(token.value)) {
        flushCurrentCommand();
        continue;
      }
      if (isShellRedirectionOperator(token.value)) {
        const next = tokens[index + 1];
        if (next?.type === "word") {
          pushPath(next.value);
          index += 1;
        }
      }
      continue;
    }

    const value = token.value.trim();
    if (value.length === 0) continue;
    if (!currentCommandName) {
      if (isShellVariableAssignment(value)) {
        continue;
      }
      currentCommandName = value;
      continue;
    }
    currentArgs.push(value);
  }

  flushCurrentCommand();
  return matches;
}

function extractAbsoluteArgs(args: readonly unknown[]): string[] {
  return args
    .filter((arg): arg is string =>
      typeof arg === "string" && ABSOLUTE_PATH_ARG_RE.test(arg.trim())
    )
    .map((arg) => arg.trim());
}

function extractAbsoluteNonOptionArgs(
  args: readonly unknown[],
  optionValueFlags: ReadonlySet<string> = new Set(),
): string[] {
  const matches: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (trimmed.length === 0) continue;
    if (optionValueFlags.has(trimmed)) {
      index++;
      continue;
    }
    if (trimmed.startsWith("-")) {
      continue;
    }
    if (ABSOLUTE_PATH_ARG_RE.test(trimmed)) {
      matches.push(trimmed);
    }
  }
  return matches;
}

function extractSedPathArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index++;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index++;
      continue;
    }
    if (SED_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index++;
      continue;
    }
    index++;
    break;
  }
  return extractAbsoluteArgs(args.slice(index));
}

function extractGrepPathArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index++;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index++;
      continue;
    }
    if (GREP_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index++;
      continue;
    }
    index++;
    break;
  }
  return extractAbsoluteArgs(args.slice(index));
}

function extractDirectCommandPathArgs(
  command: unknown,
  args: readonly unknown[],
): string[] {
  const commandName = typeof command === "string"
    ? command.trim().replace(/^.*[\\/]/, "").toLowerCase()
    : "";
  switch (commandName) {
    case "sed":
      return extractSedPathArgs(args);
    case "grep":
      return extractGrepPathArgs(args);
    case "head":
    case "tail":
      return extractAbsoluteNonOptionArgs(args, HEAD_TAIL_OPTION_VALUE_FLAGS);
    case "ls":
    case "cat":
    case "wc":
    case "mkdir":
    case "rm":
    case "mv":
    case "cp":
    case "touch":
    case "install":
    case "find":
      return extractAbsoluteNonOptionArgs(args);
    default:
      return extractAbsoluteArgs(args);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeDesktopBashCommand(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name !== 'desktop.bash') return undefined;
  const command =
    typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return undefined;
  if (!DESKTOP_GUI_LAUNCH_RE.test(command)) return undefined;
  if (DESKTOP_TERMINAL_LAUNCH_RE.test(command)) return '__gui_terminal__';
  if (DESKTOP_BROWSER_LAUNCH_RE.test(command)) {
    // Browser launches can differ materially by URL/flags; only dedupe exact
    // normalized command strings so recovery launches are not skipped.
    return `__gui_browser__:${command
      .replace(COLLAPSE_WHITESPACE_RE, ' ')
      .toLowerCase()}`;
  }
  if (DESKTOP_FILE_MANAGER_LAUNCH_RE.test(command)) return '__gui_file_manager__';
  if (DESKTOP_EDITOR_LAUNCH_RE.test(command)) return '__gui_editor__';
  return command.replace(COLLAPSE_WHITESPACE_RE, ' ').toLowerCase();
}

function shouldMarkGuiLaunchSeen(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const payload = parsed as { error?: unknown; exitCode?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return false;
    }
    if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toErrorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

type DelegationContext = NonNullable<
  ReturnType<NonNullable<DelegationToolCompositionResolver>>
>;
type DelegationSubAgentInfo = ReturnType<
  NonNullable<DelegationContext["subAgentManager"]>["getInfo"]
>;
type DelegationLifecycleEmitter = DelegationContext["lifecycleEmitter"];

function sendDeniedToolResult(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
  effectId?: string;
  effectIdempotencyKey?: string;
}): void {
  const {
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
    effectId,
    effectIdempotencyKey,
  } =
    params;
  send({
    type: "tools.result",
    payload: {
      toolName,
      result,
      durationMs: 0,
      isError: true,
      toolCallId,
      ...(effectId ? { effectId } : {}),
      ...(effectIdempotencyKey ? { effectIdempotencyKey } : {}),
      ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
    },
  });
}

function buildApprovalMessage(params: {
  ruleDescription?: string;
  toolName: string;
  sessionId: string;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
  shellProfile?: SessionShellProfile;
}): string {
  const {
    ruleDescription,
    toolName,
    sessionId,
    isSubAgentSession,
    subAgentInfo,
    shellProfile,
  } = params;
  const baseMessage = ruleDescription ?? `Approval required for ${toolName}`;
  const shellProfileContext = shellProfile
    ? buildShellProfileApprovalContext(shellProfile)
    : undefined;
  if (!isSubAgentSession || !subAgentInfo) {
    return shellProfileContext
      ? `${baseMessage}\n${shellProfileContext}`
      : baseMessage;
  }
  const taskPreview = truncateText(
    subAgentInfo.task.trim(),
    APPROVAL_TASK_PREVIEW_MAX_CHARS,
  );
  const message = (
    `${baseMessage}\n` +
    `Parent session: ${subAgentInfo.parentSessionId}\n` +
    `Sub-agent session: ${sessionId}\n` +
    `Delegated task: ${taskPreview}`
  );
  return shellProfileContext ? `${message}\n${shellProfileContext}` : message;
}

function extractDelegationObjective(
  args: Record<string, unknown>,
): string | undefined {
  const task =
    typeof args.task === "string"
      ? args.task.trim()
      : "";
  return task || undefined;
}

function sendImmediateToolError(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  hooks?: HookDispatcher;
  args: Record<string, unknown>;
  hookMetadata?: Record<string, unknown>;
  effectId?: string;
  effectIdempotencyKey?: string;
}): string {
  const {
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
    onToolEnd,
    hooks,
    args,
    hookMetadata,
    effectId,
    effectIdempotencyKey,
  } = params;
  sendDeniedToolResult({
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
    effectId,
    effectIdempotencyKey,
  });
  if (hooks) {
    void hooks.dispatch("tool:after", {
      sessionId,
      toolName,
      args,
      result,
      durationMs: 0,
      toolCallId,
      ...(hookMetadata ? { ...hookMetadata } : {}),
    });
  }
  onToolEnd?.(toolName, result, 0, toolCallId);
  return result;
}

async function runApprovalGate(params: {
  approvalEngine: ApprovalEngine | undefined;
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  parentSessionId: string | undefined;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
  shellProfile?: SessionShellProfile;
  lifecycleEmitter: DelegationLifecycleEmitter;
  send: (msg: ControlResponse) => void;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  toolCallId: string;
  effectLedger?: EffectLedger;
  effectId?: string;
  effectIdempotencyKey?: string;
  effectRef?: ApprovalEffectRef;
  incidentDiagnostics?: RuntimeIncidentDiagnostics;
  faultInjector?: RuntimeFaultInjector;
}): Promise<string | null> {
  const {
    approvalEngine,
    name,
    args,
    sessionId,
    parentSessionId,
    isSubAgentSession,
    subAgentInfo,
    shellProfile,
    lifecycleEmitter,
    send,
    onToolEnd,
    toolCallId,
    effectLedger,
    effectId,
    effectIdempotencyKey,
    effectRef,
    incidentDiagnostics,
    faultInjector,
  } = params;
  if (!approvalEngine) {
    return null;
  }

  const decision =
    typeof (approvalEngine as { simulate?: unknown }).simulate === "function"
      ? approvalEngine.simulate(name, args, sessionId, {
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
          ...(shellProfile ? { shellProfile } : {}),
          ...(effectRef ? { effect: effectRef } : {}),
        })
      : undefined;
  const legacyRule =
    decision === undefined &&
    typeof (approvalEngine as { requiresApproval?: unknown }).requiresApproval ===
      "function"
      ? approvalEngine.requiresApproval(name, args)
      : null;
  const legacyElevated =
    decision === undefined &&
    typeof (approvalEngine as { isToolElevated?: unknown }).isToolElevated ===
      "function"
      ? approvalEngine.isToolElevated(sessionId, name)
      : false;
  const legacyDenied =
    decision === undefined &&
    typeof (approvalEngine as { isToolDenied?: unknown }).isToolDenied ===
      "function"
      ? approvalEngine.isToolDenied(sessionId, name, parentSessionId)
      : false;
  if (decision === undefined) {
    if (legacyDenied) {
      const err = JSON.stringify({
        error:
          `Tool "${name}" blocked because this action was denied earlier in the request tree`,
      });
      sendDeniedToolResult({
        send,
        toolName: name,
        result: err,
        toolCallId,
        sessionId,
        isSubAgentSession,
        effectId,
        effectIdempotencyKey,
      });
      if (effectLedger && effectId) {
        await effectLedger.markDenied({
          effectId,
          reason: `Tool "${name}" blocked because this action was denied earlier in the request tree`,
        });
      }
      onToolEnd?.(name, err, 0, toolCallId);
      return err;
    }
    if (!legacyRule || legacyElevated) {
      return null;
    }
  }
  if (decision && decision.denied && !decision.required) {
    const err = JSON.stringify({
      error:
        decision.denyReason ??
        `Tool "${name}" blocked because this action was denied earlier in the request tree`,
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
      effectId,
      effectIdempotencyKey,
    });
    if (effectLedger && effectId) {
      await effectLedger.markDenied({
        effectId,
        reason:
          decision.denyReason ??
          `Tool "${name}" blocked because this action was denied earlier in the request tree`,
      });
    }
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
        toolName: name,
        payload: {
          stage: "approval",
          reason:
            decision.denyReason?.startsWith("Denied by approval policy:")
              ? "denied_by_policy"
              : "denied_previously",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  if (decision && (!decision.required || decision.elevated)) {
    return null;
  }

  if (
    effectRef &&
    incidentDiagnostics?.getSnapshot().runtimeMode === "safe_mode"
  ) {
    const err = JSON.stringify({
      error:
        'Runtime is in safe mode because approval or persistence infrastructure is degraded; mutating actions are blocked until recovery.',
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
      effectId,
      effectIdempotencyKey,
    });
    if (effectLedger && effectId) {
      await effectLedger.markDenied({
        effectId,
        reason:
          "Runtime safe mode blocked the action because approval or persistence infrastructure is degraded.",
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  const rule = decision?.rule ?? legacyRule;
  const approvalMessage =
    decision?.requestPreview?.message ??
    buildApprovalMessage({
      ruleDescription: rule?.description,
      toolName: name,
      sessionId,
      isSubAgentSession,
      subAgentInfo,
      shellProfile,
    });
  let request;
  try {
    faultInjector?.maybeThrow({
      point: "approval_store_failure",
      sessionId,
      runId: parentSessionId,
      operation: "create_request",
    });
    request = approvalEngine.createRequest(
      name,
      args,
      sessionId,
      approvalMessage,
      rule!,
      {
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
        ...(shellProfile ? { shellProfile } : {}),
        ...(effectRef ? { effect: effectRef } : {}),
        ...(decision?.approvalScopeKey
          ? { approvalScopeKey: decision.approvalScopeKey }
          : {}),
        ...(decision?.reasonCode ? { reasonCode: decision.reasonCode } : {}),
        ...(decision?.decisionSource
          ? { decisionSource: decision.decisionSource }
          : {}),
      },
    );
  } catch (error) {
    incidentDiagnostics?.report({
      domain: "approval_store",
      mode: "safe_mode",
      severity: "error",
      code: "approval_store_failure",
      message:
        error instanceof FaultInjectionError ? error.message : String(error),
      sessionId,
      ...(parentSessionId ? { runId: parentSessionId } : {}),
    });
    const err = JSON.stringify({
      error:
        "Approval subsystem is unavailable; runtime entered safe mode and refused this action.",
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
      effectId,
      effectIdempotencyKey,
    });
    if (effectLedger && effectId) {
      await effectLedger.markDenied({
        effectId,
        reason: "Approval subsystem is unavailable.",
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }
  if (effectLedger && effectId) {
    await effectLedger.recordApprovalRequested({
      effectId,
      requestId: request.id,
    });
  }
  send({
    type: "approval.request",
    payload: {
      requestId: request.id,
      action: name,
      details: args,
      message: request.message,
      deadlineAt: request.deadlineAt,
      ...(request.slaMs !== undefined ? { slaMs: request.slaMs } : {}),
      ...(request.escalateAt !== undefined
        ? { escalateAt: request.escalateAt }
        : {}),
      allowDelegatedResolution: request.allowDelegatedResolution,
      ...(request.approverGroup
        ? { approverGroup: request.approverGroup }
        : {}),
      ...(request.requiredApproverRoles &&
      request.requiredApproverRoles.length > 0
        ? { requiredApproverRoles: request.requiredApproverRoles }
        : {}),
      ...(request.parentSessionId
        ? { parentSessionId: request.parentSessionId }
        : {}),
      ...(request.subagentSessionId
        ? { subagentSessionId: request.subagentSessionId }
        : {}),
      ...(request.approvalScopeKey
        ? { approvalScopeKey: request.approvalScopeKey }
        : {}),
      ...(request.reasonCode ? { reasonCode: request.reasonCode } : {}),
      ...(request.effect ? { effect: request.effect } : {}),
    },
  });

  let response;
  try {
    faultInjector?.maybeThrow({
      point: "approval_store_failure",
      sessionId,
      runId: parentSessionId,
      operation: "request_approval",
    });
    response = await approvalEngine.requestApproval(request);
    incidentDiagnostics?.clearDomain("approval_store");
  } catch (error) {
    incidentDiagnostics?.report({
      domain: "approval_store",
      mode: "safe_mode",
      severity: "error",
      code: "approval_store_failure",
      message:
        error instanceof FaultInjectionError ? error.message : String(error),
      sessionId,
      ...(parentSessionId ? { runId: parentSessionId } : {}),
    });
    const err = JSON.stringify({
      error:
        "Approval subsystem is unavailable; runtime entered safe mode and refused this action.",
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
      effectId,
      effectIdempotencyKey,
    });
    if (effectLedger && effectId) {
      await effectLedger.markDenied({
        effectId,
        reason: "Approval subsystem is unavailable.",
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }
  if (effectLedger && effectId) {
    await effectLedger.recordApprovalResolved({
      effectId,
      response,
    });
  }
  if (response.disposition === "no") {
    const err = JSON.stringify({ error: `Tool "${name}" denied by user` });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
      effectId,
      effectIdempotencyKey,
    });
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName: name,
        payload: {
          stage: "approval",
          reason: "denied",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  if (response.disposition === "always") {
    approvalEngine.elevate(sessionId, name);
  }
  return null;
}

// ============================================================================
// Config
// ============================================================================

interface SessionToolHandlerConfig {
  /** Session ID for hook context and approval scoping. */
  sessionId: string;
  /** Optional shell profile inherited into delegated child sessions. */
  shellProfile?: SessionShellProfile;
  /** Base tool handler (from ToolRegistry). */
  baseHandler: ToolHandler;
  /** Optional factory that returns a desktop-aware handler per router ID. */
  desktopRouterFactory?: (
    routerId: string,
    allowedToolNames?: readonly string[],
  ) => ToolHandler;
  /** ID used for desktop routing (clientId for voice, sessionId for daemon). */
  routerId: string;
  /** Send a message to the connected client. */
  send: (msg: ControlResponse) => void;
  /** Hook dispatcher for tool:before/after lifecycle. */
  hooks?: HookDispatcher;
  /** Approval engine for tool gating. */
  approvalEngine?: ApprovalEngine;
  /** Runtime incident diagnostics used for safe/degraded-mode behavior. */
  incidentDiagnostics?: RuntimeIncidentDiagnostics;
  /** Explicitly gated fault-injection hooks for eval/drill runs only. */
  faultInjector?: RuntimeFaultInjector;
  /** Called when tool execution starts (before hooks). */
  onToolStart?: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ) => void;
  /** Called when tool execution finishes (after hooks). */
  onToolEnd?: (
    toolName: string,
    result: string,
    durationMs: number,
    toolCallId: string,
  ) => void;
  /** Optional resolver for live delegation runtime dependencies. */
  delegation?: DelegationToolCompositionResolver;
  /** Tool names visible to this session for child delegation scoping. */
  availableToolNames?: readonly string[];
  /** Optional working directory used to rebase relative delegated tool args. */
  defaultWorkingDirectory?: string;
  /** Optional host workspace root used to translate logical /workspace aliases. */
  workspaceAliasRoot?: string;
  /** Optional delegated workspace root. Absolute/tilde path escapes are rejected when set. */
  scopedFilesystemRoot?: string;
  /** Optional callback resolving per-call workspace overrides for this session. */
  resolveWorkspaceContext?: () =>
    | {
        defaultWorkingDirectory?: string;
        workspaceAliasRoot?: string;
        scopedFilesystemRoot?: string;
        additionalAllowedPaths?: readonly string[];
      }
    | Promise<{
        defaultWorkingDirectory?: string;
        workspaceAliasRoot?: string;
        scopedFilesystemRoot?: string;
        additionalAllowedPaths?: readonly string[];
      } | undefined>
    | undefined;
  /** Extra metadata attached to tool hook payloads for this handler. */
  hookMetadata?: Record<string, unknown>;
  /** Optional session credential broker for structured secret injection. */
  credentialBroker?: SessionCredentialBroker;
  /** Optional callback resolving the policy scope for this session. */
  resolvePolicyScope?: () => PolicyEvaluationScope | undefined;
  /** Persistent effect ledger for first-class side-effect records. */
  effectLedger?: EffectLedger;
  /** Optional channel/source label attached to emitted effect records. */
  effectChannel?: string;
  /** Durable task registry used for public task handles. */
  taskStore?: TaskStore | null;
  /** Runtime-contract feature flags that gate handle-first delegation. */
  runtimeContractFlags?: RuntimeContractFlags;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a session-scoped tool handler that integrates hooks, approval gating,
 * desktop routing, and WebSocket notifications.
 *
 * Flow:
 * 1. `tool:before` hook — if blocked, return error (NO WS messages sent)
 * 2. `onToolStart` callback
 * 3. Send `tools.executing` to client
 * 4. Approval gate — if denied, send `tools.result` (isError), call `onToolEnd`, return
 * 5. Select handler via desktop router or base handler
 * 6. Execute and time it
 * 7. Send `tools.result` to client
 * 8. `tool:after` hook
 * 9. `onToolEnd` callback
 */
export function createSessionToolHandler(config: SessionToolHandlerConfig): ToolHandler {
  const {
    sessionId,
    shellProfile,
    baseHandler,
    desktopRouterFactory,
    routerId,
    send,
    hooks,
    approvalEngine,
    incidentDiagnostics,
    faultInjector,
    onToolStart,
    onToolEnd,
    delegation,
    availableToolNames,
    hookMetadata,
    credentialBroker,
    resolvePolicyScope,
    effectLedger,
    effectChannel,
    taskStore,
    runtimeContractFlags,
    resolveWorkspaceContext,
  } = config;
  let toolCallSeq = 0;
  // Per-message duplicate guard to avoid opening the same GUI app twice when
  // the model emits repeated desktop.bash launch calls in one turn.
  const seenGuiLaunches = new Set<string>();
  const nextToolCallId = (): string =>
    `tool-${Date.now().toString(36)}-${++toolCallSeq}`;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const toolName = normalizeToolName(name);
    const normalizedToolCallArgs = normalizeToolCallArguments(toolName, args);
    const seededSessionId =
      typeof normalizedToolCallArgs[SESSION_ID_ARG] === "string" &&
      normalizedToolCallArgs[SESSION_ID_ARG].trim().length > 0
        ? normalizedToolCallArgs[SESSION_ID_ARG].trim()
        : undefined;
    const sessionIdentity = sessionId ?? seededSessionId;
    const isSubAgentSession = isSubAgentSessionId(sessionIdentity);
    const workspaceContext = (await resolveWorkspaceContext?.()) ?? {};
    const defaultWorkingDirectory =
      workspaceContext.defaultWorkingDirectory ?? config.defaultWorkingDirectory;
    const scopedFilesystemRoot =
      workspaceContext.scopedFilesystemRoot ?? config.scopedFilesystemRoot;
    const workspaceAliasRoot =
      workspaceContext.workspaceAliasRoot ??
      config.workspaceAliasRoot ??
      scopedFilesystemRoot ??
      defaultWorkingDirectory;
    const normalizedToolArgs = stripInternalToolArgs(normalizedToolCallArgs);
    const {
      args: normalizedArgs,
      missingDefaultWorkingDirectory,
    } = applyDefaultWorkingDirectory(
      toolName,
      isSubAgentSession
        ? normalizedToolArgs
        : applyWorkspaceAliasTranslation(
          toolName,
          normalizedToolArgs,
          workspaceAliasRoot,
        ),
      defaultWorkingDirectory,
    );
    if (isSubAgentSession) {
      const delegatedAliasViolation = validateDelegatedCanonicalToolPaths(
        toolName,
        normalizedArgs,
      );
      if (delegatedAliasViolation) {
        return JSON.stringify({
          error: delegatedAliasViolation,
        });
      }
    }
    if (
      missingDefaultWorkingDirectory &&
      !missingDefaultWorkingDirectory.bootstrapPermitted
    ) {
      return JSON.stringify({
        error: buildMissingDefaultWorkingDirectoryError(
          missingDefaultWorkingDirectory.path,
          false,
        ),
      });
    }
    const delegationContext = delegation?.();
    const subAgentManager = delegationContext?.subAgentManager ?? null;
    const workerManager = delegationContext?.workerManager ?? null;
    const policyEngine = delegationContext?.policyEngine ?? null;
    const verifier = delegationContext?.verifier ?? null;
    const lifecycleEmitter = delegationContext?.lifecycleEmitter ?? null;
    const progressTracker = delegationContext?.progressTracker ?? null;
    const unsafeBenchmarkMode = delegationContext?.unsafeBenchmarkMode === true;
    const subAgentInfo = isSubAgentSession
      ? subAgentManager?.getInfo(sessionIdentity) ?? null
      : null;
    const subAgentExecutionContext =
      isSubAgentSession && typeof subAgentManager?.getExecutionContext === "function"
        ? subAgentManager.getExecutionContext(sessionIdentity)
        : undefined;
    const parentSessionId = subAgentInfo?.parentSessionId;
    const policyScope = resolvePolicyScope?.();
    const credentialPreparation = credentialBroker?.prepare({
      sessionId,
      toolName,
      args: normalizedArgs,
      scope: policyScope,
    });
    if (credentialPreparation && !credentialPreparation.ok) {
      return JSON.stringify({ error: credentialPreparation.error });
    }
    const credentialPrepared = credentialPreparation?.prepared;
    const enrichedHookMetadata = {
      ...(hookMetadata ? { ...hookMetadata } : {}),
      ...(credentialPrepared
        ? { credentialPreview: credentialPrepared.preview }
        : {}),
    };

    const launchKey = normalizeDesktopBashCommand(toolName, args);
    if (launchKey) {
      if (seenGuiLaunches.has(launchKey)) {
        return JSON.stringify({
          stdout: '',
          stderr: '',
          exitCode: 0,
          backgrounded: true,
          skippedDuplicate: true,
        });
      }
    }

    const effectiveDefaultWorkingDirectory =
      subAgentExecutionContext?.workspaceRoot ?? defaultWorkingDirectory;
    const effectiveScopedFilesystemRoot =
      subAgentExecutionContext?.workspaceRoot ?? scopedFilesystemRoot;
    const toolCallId = nextToolCallId();
    const delegationObjective = extractDelegationObjective(normalizedArgs);

    if (
      lifecycleEmitter &&
      policyEngine &&
      !isSubAgentSession &&
      policyEngine.isDelegationTool(toolName)
    ) {
      lifecycleEmitter.emit({
        type: 'subagents.planned',
        timestamp: Date.now(),
        sessionId,
        toolName: name,
        payload: {
          decisionThreshold: policyEngine.snapshot().spawnDecisionThreshold,
          ...(delegationObjective ? { objective: delegationObjective } : {}),
        },
      });
    }

    if (policyEngine) {
      const decision = policyEngine.evaluate({
        sessionId,
        toolName,
        args: normalizedArgs,
        isSubAgentSession,
      });
      if (
        decision.matchedRule === "unsafe_benchmark_bypass" &&
        lifecycleEmitter &&
        policyEngine.isDelegationTool(toolName)
      ) {
        lifecycleEmitter.emit({
          type: "subagents.policy_bypassed",
          timestamp: Date.now(),
          sessionId,
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
          toolName,
          payload: {
            stage: "policy",
            unsafeBenchmarkMode: true,
            matchedRule: decision.matchedRule,
            decisionThreshold: decision.threshold,
            isSubAgentSession,
            ...(delegationObjective ? { objective: delegationObjective } : {}),
          },
        });
      }
      if (!decision.allowed) {
        const err = JSON.stringify({
          error: decision.reason ?? `Tool "${toolName}" blocked by delegation policy`,
        });
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: {
              stage: 'policy',
              reason: decision.reason,
            },
          });
        }
        return err;
      }
    }

    // 1. Hook: tool:before (policy gate, progress tracking, etc.)
    if (hooks) {
      const beforeResult = await hooks.dispatch('tool:before', {
        sessionId,
        toolName,
        args: normalizedArgs,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
      if (!beforeResult.completed) {
        // Bug fix: do NOT send tools.executing when hook blocks — the tool
        // never started executing, so the client shouldn't show a tool card.
        const hookReason =
          typeof beforeResult.payload.reason === "string" &&
          beforeResult.payload.reason.trim().length > 0
            ? beforeResult.payload.reason.trim()
            : `Tool "${toolName}" blocked by hook`;
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: { stage: 'hook_before', reason: hookReason },
          });
        }
        return JSON.stringify({ error: hookReason });
      }
    }

    // 2. Notify caller: tool execution starting
    const effectExecutionContext = getCurrentEffectExecutionContext();
    const shouldRecordEffect =
      effectLedger !== undefined && isMutatingTool(toolName);
    const effectTargets = shouldRecordEffect
      ? buildEffectTargets({
          toolName,
          args: normalizedArgs,
          defaultWorkingDirectory: effectiveDefaultWorkingDirectory,
          executionContext: subAgentExecutionContext,
        })
      : [];
    const effectKind = inferEffectKind(toolName);
    const effectIdempotencyKey =
      shouldRecordEffect
        ? deriveEffectIdempotencyKey({
            sessionId,
            toolName,
            toolCallId,
            args: normalizedArgs,
            executionContext: effectExecutionContext,
          })
        : undefined;
    const effectPathTargets =
      effectTargets
        .map((target) => target.path)
        .filter((path): path is string => typeof path === "string" && path.length > 0);
    const preExecutionSnapshots =
      shouldRecordEffect && effectPathTargets.length > 0
        ? await Promise.all(
            effectPathTargets.map((path) => captureFilesystemSnapshot(path)),
          )
        : [];
    const provisionalCompensation =
      shouldRecordEffect
        ? buildCompensationState({
            toolName,
            args: normalizedArgs,
            effectKind,
            preExecutionSnapshots,
            effectId: `${toolCallId}:effect`,
          })
        : { status: "not_available" as const, actions: [] };
    const inferredEffectClass = inferEffectClass({
      toolName,
      explicitEffectClass: subAgentExecutionContext?.effectClass,
    });
    const preApprovalEffectRef =
      shouldRecordEffect && effectIdempotencyKey
        ? buildApprovalEffectRef({
            effectId: `${toolCallId}:effect`,
            effectIdempotencyKey,
            toolName,
            targets: effectTargets,
            effectClass: inferredEffectClass,
            effectKind,
            compensationAvailable:
              provisionalCompensation.actions.some((action) => action.supported),
            preExecutionSnapshots,
          })
        : undefined;
    const approvalDecision =
      approvalEngine &&
      typeof (approvalEngine as { simulate?: unknown }).simulate === "function"
        ? approvalEngine.simulate(toolName, normalizedArgs, sessionId, {
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
            ...(shellProfile ? { shellProfile } : {}),
            ...(preApprovalEffectRef ? { effect: preApprovalEffectRef } : {}),
          })
        : undefined;
    let effectRecord =
      shouldRecordEffect && effectLedger && effectIdempotencyKey
        ? await effectLedger.beginEffect({
            id: `${toolCallId}:effect`,
            idempotencyKey: effectIdempotencyKey,
            toolCallId,
            toolName,
            args: normalizedArgs,
            scope: {
              sessionId,
              ...(parentSessionId ? { parentSessionId } : {}),
              ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
              ...(effectExecutionContext?.pipelineId
                ? { pipelineId: effectExecutionContext.pipelineId }
                : {}),
              ...(effectExecutionContext?.stepName
                ? { stepName: effectExecutionContext.stepName }
                : {}),
              ...(typeof effectExecutionContext?.stepIndex === "number"
                ? { stepIndex: effectExecutionContext.stepIndex }
                : {}),
              ...(effectExecutionContext?.runId
                ? { runId: effectExecutionContext.runId }
                : typeof hookMetadata?.backgroundRunId === "string"
                  ? { runId: hookMetadata.backgroundRunId }
                  : {}),
              ...(effectExecutionContext?.channel
                ? { channel: effectExecutionContext.channel }
                : effectChannel
                  ? { channel: effectChannel }
                  : {}),
            },
            kind: effectKind,
            effectClass: inferredEffectClass,
            intentSummary: buildEffectIntentSummary({
              toolName,
              targets: effectTargets,
            }),
            targets: effectTargets,
            createdAt: Date.now(),
            requiresApproval:
              approvalDecision?.required === true,
            ...(preExecutionSnapshots.length > 0
              ? { preExecutionSnapshots }
              : {}),
            metadata: {
              ...(policyScope ? { policyScope } : {}),
              ...(hookMetadata ? { hookMetadata } : {}),
              ...(approvalDecision?.reasonCode
                ? { approvalReasonCode: approvalDecision.reasonCode }
                : {}),
              ...(approvalDecision?.autoApprovedReasonCode
                ? {
                    autoApprovalReasonCode:
                      approvalDecision.autoApprovedReasonCode,
                  }
                : {}),
            },
          })
        : undefined;
    const approvalEffectRef =
      effectRecord && effectIdempotencyKey
        ? buildApprovalEffectRef({
            effectId: effectRecord.id,
            effectIdempotencyKey,
            toolName,
            targets: effectTargets,
            effectClass: effectRecord.effectClass,
            effectKind,
            compensationAvailable:
              provisionalCompensation.actions.some((action) => action.supported),
            preExecutionSnapshots,
          })
        : undefined;

    onToolStart?.(toolName, normalizedArgs, toolCallId);

    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: 'subagents.tool.executing',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: {
          args: normalizedArgs,
          toolCallId,
          ...(subAgentInfo?.parentToolCallId
            ? { parentToolCallId: subAgentInfo.parentToolCallId }
            : {}),
        },
      });
      if (progressTracker) {
        progressTracker.onToolExecuting({
          subagentSessionId: sessionId,
          ...(subAgentInfo?.parentSessionId
            ? { parentSessionId: subAgentInfo.parentSessionId }
            : {}),
          ...(subAgentInfo?.parentToolCallId
            ? { parentToolCallId: subAgentInfo.parentToolCallId }
            : {}),
          toolName,
          args: normalizedArgs,
        });
        const snapshot = progressTracker.consumeSnapshotIfDue(sessionId);
        if (snapshot) {
          lifecycleEmitter.emit({
            type: "subagents.progress",
            timestamp: Date.now(),
            sessionId,
            ...(subAgentInfo?.parentSessionId
              ? { parentSessionId: subAgentInfo.parentSessionId }
              : {}),
            subagentSessionId: sessionId,
            toolName,
            payload: {
              progress: snapshot,
              ...(subAgentInfo?.parentToolCallId
                ? { parentToolCallId: subAgentInfo.parentToolCallId }
                : {}),
            },
          });
        }
      }
    }

    if (
      incidentDiagnostics?.getSnapshot().runtimeMode === "safe_mode" &&
      effectRecord
    ) {
      if (effectLedger) {
        effectRecord =
          (await effectLedger.markDenied({
            effectId: effectRecord.id,
            reason:
              "Runtime safe mode blocked the mutation because persistence or approval infrastructure is degraded.",
          })) ?? effectRecord;
      }
      const safeModeError = JSON.stringify({
        error:
          "Runtime is in safe mode because persistence or approval infrastructure is degraded; mutating actions are blocked until recovery.",
      });
      return sendImmediateToolError({
        send,
        toolName,
        result: safeModeError,
        toolCallId,
        sessionId,
        isSubAgentSession,
        onToolEnd,
        hookMetadata,
        args: normalizedArgs,
        hooks,
        effectId: effectRecord.id,
        effectIdempotencyKey,
      });
    }

    // 3. Send tools.executing to client
    send({
      type: 'tools.executing',
      payload: {
        toolName,
        args: normalizedArgs,
        toolCallId,
        ...(effectRecord ? { effectId: effectRecord.id } : {}),
        ...(effectIdempotencyKey ? { effectIdempotencyKey } : {}),
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    // 4. Approval gate
    const approvalError = await runApprovalGate({
      approvalEngine,
      name: toolName,
      args: normalizedArgs,
      sessionId,
      parentSessionId,
      isSubAgentSession,
      subAgentInfo,
      shellProfile,
      lifecycleEmitter,
      send,
      onToolEnd,
      toolCallId,
      effectLedger,
      effectId: effectRecord?.id,
      effectIdempotencyKey,
      effectRef: approvalEffectRef,
      incidentDiagnostics,
      faultInjector,
    });
    if (approvalError) {
      return approvalError;
    }

    const sendRecordedImmediateToolError = async (
      result: string,
      error: string,
    ): Promise<string> => {
      if (effectLedger && effectRecord) {
        effectRecord =
          (await effectLedger.recordOutcome({
            effectId: effectRecord.id,
            success: false,
            isError: true,
            durationMs: 0,
            result,
            error,
            observedMutationsUnknown: effectKind === "shell_command",
          })) ?? effectRecord;
      }
      return sendImmediateToolError({
        send,
        toolName,
        result,
        toolCallId,
        sessionId,
        isSubAgentSession,
        onToolEnd,
        hooks,
        args: normalizedArgs,
        hookMetadata: enrichedHookMetadata,
        effectId: effectRecord?.id,
        effectIdempotencyKey,
      });
    };

    let executionArgs = normalizedArgs;
    if (credentialBroker && credentialPrepared) {
      const injectionResult = credentialBroker.inject({
        prepared: credentialPrepared,
        args: normalizedArgs,
        scope: policyScope,
      });
      if (!injectionResult.ok) {
        return sendRecordedImmediateToolError(
          JSON.stringify({ error: injectionResult.error }),
          injectionResult.error,
        );
      }
      executionArgs = injectionResult.args;
    }
    const delegatedParentAllowedRoots = deriveSessionAllowedPaths({
      explicitAdditionalAllowedPaths: [
        ...(workspaceContext.additionalAllowedPaths ?? []),
        ...(subAgentExecutionContext?.allowedReadRoots ?? []),
        ...(subAgentExecutionContext?.allowedWriteRoots ?? []),
      ],
      scopedFilesystemRoot: effectiveScopedFilesystemRoot,
      defaultWorkingDirectory: effectiveDefaultWorkingDirectory,
    });
    executionArgs = applySessionAllowedRoots(
      toolName,
      executionArgs,
      delegatedParentAllowedRoots,
    );
    executionArgs = applySessionTaskListId(toolName, executionArgs, sessionIdentity);
    executionArgs = applyTaskActorContext(
      toolName,
      executionArgs,
      isSubAgentSession,
      subAgentInfo,
    );
    executionArgs = applySessionId(toolName, executionArgs, sessionIdentity);
    executionArgs = applyAdvertisedToolNames(
      toolName,
      executionArgs,
      availableToolNames,
    );

    const subAgentEnvelopeError = isSubAgentSession
      ? enforceSubAgentExecutionEnvelope({
        toolName,
        args: executionArgs,
        executionContext: subAgentExecutionContext,
        defaultWorkingDirectory: effectiveDefaultWorkingDirectory,
      })
      : undefined;
    if (subAgentEnvelopeError) {
      return sendRecordedImmediateToolError(
        JSON.stringify({ error: subAgentEnvelopeError }),
        subAgentEnvelopeError,
      );
    }

    // 5. Select handler: delegation executor or desktop-aware/base handler
    const routedHandler = desktopRouterFactory
      ? desktopRouterFactory(routerId, availableToolNames)
      : baseHandler;
    const activeHandler: ToolHandler =
      toolName === EXECUTE_WITH_AGENT_TOOL_NAME
        ? async (_toolName, toolArgs) =>
          executeDelegationTool({
            toolArgs,
            name: toolName,
            sessionId,
            shellProfile,
            toolCallId,
            subAgentManager,
            lifecycleEmitter,
            verifier,
            taskStore,
            runtimeContractFlags,
            availableToolNames,
            launchShellAgentTask: delegationContext?.launchShellAgentTask,
            defaultWorkingDirectory: effectiveDefaultWorkingDirectory,
            parentAllowedReadRoots: delegatedParentAllowedRoots,
            parentAllowedWriteRoots: delegatedParentAllowedRoots,
            delegationThreshold:
              policyEngine?.snapshot().spawnDecisionThreshold,
            unsafeBenchmarkMode,
          })
        : toolName === COORDINATOR_MODE_TOOL_NAME
          ? async (_toolName, toolArgs) =>
            executeCoordinatorModeTool({
              toolArgs,
              name: toolName,
              sessionId,
              toolCallId,
              subAgentManager,
              workerManager,
              lifecycleEmitter,
              verifier,
              taskStore,
              runtimeContractFlags,
              availableToolNames,
              defaultWorkingDirectory: effectiveDefaultWorkingDirectory,
              parentAllowedReadRoots: delegatedParentAllowedRoots,
              parentAllowedWriteRoots: delegatedParentAllowedRoots,
              delegationThreshold:
                policyEngine?.snapshot().spawnDecisionThreshold,
              unsafeBenchmarkMode,
            })
          : routedHandler;

    // 6. Execute and time
    if (effectLedger && effectRecord) {
      effectRecord =
        (await effectLedger.markExecuting(effectRecord.id)) ?? effectRecord;
    }
    const start = Date.now();
    let result: string;
    try {
      faultInjector?.maybeThrow({
        point: "tool_timeout",
        sessionId,
        operation: toolName,
      });
      result = await activeHandler(toolName, executionArgs);
    } catch (error) {
      if (
        error instanceof FaultInjectionError &&
        error.point === "tool_timeout"
      ) {
        incidentDiagnostics?.report({
          domain: "tool",
          mode: "degraded",
          severity: "warn",
          code: "tool_timeout",
          message: error.message,
          sessionId,
          ...(parentSessionId ? { runId: parentSessionId } : {}),
        });
      }
      if (effectLedger && effectRecord) {
        effectRecord =
          (await effectLedger.recordOutcome({
            effectId: effectRecord.id,
            success: false,
            isError: true,
            durationMs: Date.now() - start,
            result: JSON.stringify({ error: toErrorString(error) }),
            error: toErrorString(error),
            observedMutationsUnknown: effectKind === "shell_command",
          })) ?? effectRecord;
      }
      if (isSubAgentSession && lifecycleEmitter) {
        lifecycleEmitter.emit({
          type: 'subagents.failed',
          timestamp: Date.now(),
          sessionId,
          subagentSessionId: sessionId,
          toolName,
          payload: {
            stage: 'execution',
            error: toErrorString(error),
            toolCallId,
          },
        });
      }
      throw error;
    }
    const durationMs = Date.now() - start;
    incidentDiagnostics?.clearDomain("tool");
    const isError = didToolCallFail(false, result);

    if (effectLedger && effectRecord) {
      const postExecutionSnapshots =
        effectPathTargets.length > 0
          ? await Promise.all(
              effectPathTargets.map((path) => captureFilesystemSnapshot(path)),
            )
          : [];
      const compensation = buildCompensationState({
        toolName,
        args: executionArgs,
        effectKind,
        preExecutionSnapshots,
        resultObject: tryParseJsonRecord(result),
        effectId: effectRecord.id,
      });
      effectRecord =
        (await effectLedger.recordOutcome({
          effectId: effectRecord.id,
          success: !isError,
          isError,
          durationMs,
          result,
          ...(isError
            ? { error: extractToolFailureTextFromResult(result) }
            : {}),
          ...(postExecutionSnapshots.length > 0
            ? { postExecutionSnapshots }
            : {}),
          compensation,
          observedMutationsUnknown: effectKind === "shell_command",
        })) ?? effectRecord;
    }

    if (effectRecord) {
      result = enrichToolResultMetadata(
        result,
        buildEffectResultMetadata(effectRecord),
      );
    }

    const verificationMetadata = buildVerificationResultMetadata({
      toolName,
      args: executionArgs,
      defaultWorkingDirectory,
      scopedFilesystemRoot,
    });
    if (verificationMetadata) {
      result = enrichToolResultMetadata(result, verificationMetadata);
    }

    if (launchKey && shouldMarkGuiLaunchSeen(result)) {
      seenGuiLaunches.add(launchKey);
    }

    // 7. Send tools.result to client
    send({
      type: 'tools.result',
      payload: {
        toolName,
        result,
        durationMs,
        isError,
        toolCallId,
        ...(effectRecord ? { effectId: effectRecord.id } : {}),
        ...(effectIdempotencyKey ? { effectIdempotencyKey } : {}),
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    if (isSubAgentSession && lifecycleEmitter) {
      const verifierRequirement = verifier?.resolveVerifierRequirement({
        runtimeRequired: runtimeContractFlags?.verifierRuntimeRequired,
        projectBootstrap: runtimeContractFlags?.verifierProjectBootstrap,
        workspaceRoot: defaultWorkingDirectory ?? scopedFilesystemRoot,
      });
      lifecycleEmitter.emit({
        type: 'subagents.tool.result',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: {
          result,
          durationMs,
          isError,
          toolCallId,
          ...(subAgentInfo?.parentToolCallId
            ? { parentToolCallId: subAgentInfo.parentToolCallId }
            : {}),
          ...(verifierRequirement
            ? { verifierRequirement }
            : {}),
        },
      });
      if (progressTracker) {
        progressTracker.onToolResult({
          subagentSessionId: sessionId,
          ...(subAgentInfo?.parentSessionId
            ? { parentSessionId: subAgentInfo.parentSessionId }
            : {}),
          ...(subAgentInfo?.parentToolCallId
            ? { parentToolCallId: subAgentInfo.parentToolCallId }
            : {}),
          toolName,
          isError,
          durationMs,
        });
        const snapshot = progressTracker.flushSnapshot(sessionId);
        if (snapshot) {
          lifecycleEmitter.emit({
            type: "subagents.progress",
            timestamp: Date.now(),
            sessionId,
            ...(subAgentInfo?.parentSessionId
              ? { parentSessionId: subAgentInfo.parentSessionId }
              : {}),
            subagentSessionId: sessionId,
            toolName,
            payload: {
              progress: snapshot,
              ...(subAgentInfo?.parentToolCallId
                ? { parentToolCallId: subAgentInfo.parentToolCallId }
                : {}),
            },
          });
        }
      }
    }

    // 8. Hook: tool:after (progress tracking)
    if (hooks) {
      await hooks.dispatch('tool:after', {
        sessionId,
        toolName,
        args: normalizedArgs,
        result,
        durationMs,
        toolCallId,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
    }

    // 9. Notify caller: tool execution finished
    onToolEnd?.(toolName, result, durationMs, toolCallId);

    return result;
  };
}
