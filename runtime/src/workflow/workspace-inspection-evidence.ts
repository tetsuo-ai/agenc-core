import { areDocumentationOnlyArtifacts } from "./artifact-paths.js";
import {
  isPathWithinRoot,
  normalizeEnvelopePath,
  normalizeWorkspaceRoot,
} from "./path-normalization.js";

interface ToolCallLike {
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: string;
  readonly isError?: boolean;
}

const WORKSPACE_AUDIT_VERB_RE =
  /\b(?:review|audit|inspect|assess|evaluate|verify|compare|check|analy[sz]e|map|survey|inventory|trace)\b/i;
const WORKSPACE_TARGET_NOUN_RE =
  /\b(?:repo(?:sitory)?|codebase|workspace|source tree|directory|directories|layout|structure|implementation|files?|folders?)\b/i;
const WORKSPACE_CHANGE_PHRASE_RE =
  /\b(?:repo(?:sitory)?|codebase|workspace|directory|directories|layout|structure|implementation|code|files?|folders?)\s+changes?\b/i;
const WORKSPACE_STATE_PHRASE_RE =
  /\b(?:state\s+of\s+(?:the\s+)?(?:repo(?:sitory)?|codebase|workspace|implementation)|(?:repo(?:sitory)?|codebase|workspace|implementation)\s+state)\b/i;
const WORKSPACE_AUDIT_TARGET_RE = new RegExp(
  `${WORKSPACE_TARGET_NOUN_RE.source}|${WORKSPACE_CHANGE_PHRASE_RE.source}|${WORKSPACE_STATE_PHRASE_RE.source}`,
  "i",
);
const CURRENT_WORKSPACE_STATE_RE = new RegExp(
  String.raw`\b(?:current|existing|actual|live|recent)\s+(?:${WORKSPACE_TARGET_NOUN_RE.source}|${WORKSPACE_CHANGE_PHRASE_RE.source}|${WORKSPACE_STATE_PHRASE_RE.source})`,
  "i",
);
const WORKSPACE_ALIGNMENT_RE = new RegExp(
  String.raw`\b(?:reflect(?:s)?|align(?:s)?|match(?:es)?|correspond(?:s)?)\b[\s\S]{0,96}(?:\b(?:current|existing|actual|live|recent)\b[\s\S]{0,48})?(?:${WORKSPACE_TARGET_NOUN_RE.source}|${WORKSPACE_CHANGE_PHRASE_RE.source}|${WORKSPACE_STATE_PHRASE_RE.source})`,
  "i",
);
const ARTIFACT_GAP_DISCOVERY_RE =
  /\b(?:find|identify|review|inspect|analy[sz]e|check|look\s+for|spot|go\s+through|read\s+through)\b[\s\S]{0,140}\b(?:gaps?|missing sections?|missing items?|outdated sections?|outdated items?|inconsistencies)\b|\b(?:if|whether)\s+there\s+(?:are|is)\s+(?:any\s+)?(?:gaps?|missing sections?|missing items?|outdated sections?|outdated items?|inconsistencies)\b/i;
const ARTIFACT_GAP_REPAIR_RE =
  /\b(?:fill|add|address|fix|close|resolve|cover|update|correct)\b[\s\S]{0,80}\b(?:them|those|it|the artifact|the file|the document|the plan|the spec|the gaps?|the missing sections?|the missing items?)\b/i;
const SHELL_WORKSPACE_INSPECTION_COMMAND_RE =
  /\b(?:ls|find|tree|rg|ripgrep|git\s+(?:status|diff|ls-files)|stat)\b/i;
const DIRECT_WORKSPACE_INSPECTION_TOOL_NAMES = new Set([
  "system.readFile",
  "system.listDir",
  "system.stat",
  "desktop.text_editor",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const SHELL_WORKSPACE_INSPECTION_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
]);

export function textRequiresWorkspaceGroundedArtifactUpdate(
  value: string,
): boolean {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  if (normalized.length === 0) {
    return false;
  }
  return (
    (WORKSPACE_AUDIT_VERB_RE.test(normalized) &&
      WORKSPACE_AUDIT_TARGET_RE.test(normalized)) ||
    CURRENT_WORKSPACE_STATE_RE.test(normalized) ||
    WORKSPACE_ALIGNMENT_RE.test(normalized) ||
    (ARTIFACT_GAP_DISCOVERY_RE.test(normalized) &&
      ARTIFACT_GAP_REPAIR_RE.test(normalized))
  );
}

export function criterionRequiresWorkspaceInspectionVerification(
  criterion: string,
): boolean {
  const normalized = criterion.trim();
  if (normalized.length === 0) {
    return false;
  }
  return textRequiresWorkspaceGroundedArtifactUpdate(normalized);
}

function parseToolCallArgs(toolCall: ToolCallLike): Record<string, unknown> {
  return toolCall.args &&
      typeof toolCall.args === "object" &&
      !Array.isArray(toolCall.args)
    ? (toolCall.args as Record<string, unknown>)
    : {};
}

function parseToolCallResult(toolCall: ToolCallLike): Record<string, unknown> | undefined {
  if (typeof toolCall.result !== "string" || toolCall.result.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function pushPathCandidate(
  results: Set<string>,
  rawValue: unknown,
  workspaceRoot?: string,
): void {
  if (typeof rawValue !== "string") {
    return;
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return;
  }
  const normalized = normalizeEnvelopePath(trimmed, workspaceRoot);
  if (normalized.length > 0) {
    results.add(normalized);
  }
}

function pathMatchesArtifact(
  path: string,
  artifact: string,
  workspaceRoot?: string,
): boolean {
  const normalizedPath = normalizeEnvelopePath(path, workspaceRoot);
  const normalizedArtifact = normalizeEnvelopePath(artifact, workspaceRoot);
  return normalizedPath === normalizedArtifact ||
    normalizedPath.endsWith(`/${normalizedArtifact}`) ||
    normalizedArtifact.endsWith(`/${normalizedPath}`);
}

function pathExcludedFromWorkspaceInspection(params: {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly targetArtifacts: readonly string[];
  readonly requiredSourceArtifacts: readonly string[];
}): boolean {
  if (
    params.targetArtifacts.some((artifact) =>
      pathMatchesArtifact(params.path, artifact, params.workspaceRoot)
    )
  ) {
    return true;
  }
  return params.requiredSourceArtifacts
    .filter((artifact) => areDocumentationOnlyArtifacts([artifact]))
    .some((artifact) =>
      pathMatchesArtifact(params.path, artifact, params.workspaceRoot)
    );
}

export function collectWorkspaceInspectionPathCandidates(params: {
  readonly toolCall: ToolCallLike;
  readonly workspaceRoot?: string;
}): readonly string[] {
  const args = parseToolCallArgs(params.toolCall);
  const parsedResult = parseToolCallResult(params.toolCall);
  const candidates = new Set<string>();
  pushPathCandidate(candidates, args.path, params.workspaceRoot);
  pushPathCandidate(candidates, args.source, params.workspaceRoot);
  pushPathCandidate(candidates, args.destination, params.workspaceRoot);
  pushPathCandidate(candidates, args.cwd, params.workspaceRoot);
  pushPathCandidate(candidates, parsedResult?.path, params.workspaceRoot);
  if (
    SHELL_WORKSPACE_INSPECTION_TOOL_NAMES.has(params.toolCall.name?.trim() ?? "")
  ) {
    for (const pathCandidate of extractShellWorkspaceInspectionPathCandidates(args)) {
      pushPathCandidate(candidates, pathCandidate, params.workspaceRoot);
    }
  }
  return [...candidates];
}

function extractShellWorkspaceInspectionPathCandidates(
  args: Record<string, unknown>,
): readonly string[] {
  const command =
    typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
  const argv = Array.isArray(args.args)
    ? args.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (argv.length === 0) {
    return [];
  }

  if (command === "ls" || command === "tree" || command === "stat") {
    return argv.filter((entry) => isShellPathOperand(entry));
  }

  if (command === "find") {
    const firstPathOperand = argv.find((entry) => isShellPathOperand(entry));
    return firstPathOperand ? [firstPathOperand] : [];
  }

  return [];
}

function isShellPathOperand(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("-")) {
    return false;
  }
  if (/[|&;<>(){}\[\]*?=]/.test(trimmed)) {
    return false;
  }
  return true;
}

function isMeaningfulInspectionPath(params: {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly targetArtifacts: readonly string[];
  readonly requiredSourceArtifacts: readonly string[];
}): boolean {
  const normalizedPath = normalizeEnvelopePath(params.path, params.workspaceRoot);
  if (normalizedPath.length === 0) {
    return false;
  }
  if (
    params.workspaceRoot &&
    !isPathWithinRoot(normalizedPath, params.workspaceRoot) &&
    normalizedPath !== normalizeWorkspaceRoot(params.workspaceRoot)
  ) {
    return false;
  }
  return !pathExcludedFromWorkspaceInspection({
    path: normalizedPath,
    workspaceRoot: params.workspaceRoot,
    targetArtifacts: params.targetArtifacts,
    requiredSourceArtifacts: params.requiredSourceArtifacts,
  });
}

export function isMeaningfulWorkspaceInspectionToolCall(params: {
  readonly toolCall: ToolCallLike;
  readonly workspaceRoot?: string;
  readonly targetArtifacts?: readonly string[];
  readonly requiredSourceArtifacts?: readonly string[];
}): boolean {
  if (params.toolCall.isError === true) {
    return false;
  }
  const toolName = params.toolCall.name?.trim() ?? "";
  if (toolName.length === 0) {
    return false;
  }
  const targetArtifacts = params.targetArtifacts ?? [];
  const requiredSourceArtifacts = params.requiredSourceArtifacts ?? [];
  const pathCandidates = collectWorkspaceInspectionPathCandidates({
    toolCall: params.toolCall,
    workspaceRoot: params.workspaceRoot,
  });
  const hasMeaningfulPath = pathCandidates.some((path) =>
    isMeaningfulInspectionPath({
      path,
      workspaceRoot: params.workspaceRoot,
      targetArtifacts,
      requiredSourceArtifacts,
    })
  );

  if (DIRECT_WORKSPACE_INSPECTION_TOOL_NAMES.has(toolName)) {
    return hasMeaningfulPath;
  }

  if (!SHELL_WORKSPACE_INSPECTION_TOOL_NAMES.has(toolName)) {
    return false;
  }

  const args = parseToolCallArgs(params.toolCall);
  const commandText = [
    typeof args.command === "string" ? args.command : "",
    ...(Array.isArray(args.args)
      ? args.args.filter((entry): entry is string => typeof entry === "string")
      : []),
  ]
    .join(" ")
    .trim();
  if (!SHELL_WORKSPACE_INSPECTION_COMMAND_RE.test(commandText)) {
    return false;
  }
  return hasMeaningfulPath;
}
