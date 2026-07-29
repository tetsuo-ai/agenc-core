import type { SearchMatch, WorkbenchAttachment, WorkbenchCommand } from "./types.js";
import { normalizeWorkspacePathForReferences } from "./pathReferences.js";
import type { BufferIntegrationIntent } from "./buffer/providers/types.js";

export function openPreviewCommand(
  path: string,
  line?: number,
  focus = true,
): WorkbenchCommand {
  return { type: "openPreview", path: normalizeCommandPath(path), line, focus };
}

export function openBufferCommand(
  path: string,
  line?: number,
  focus = true,
): WorkbenchCommand {
  return { type: "openBuffer", path: normalizeCommandPath(path), line, focus };
}

export function attachFileCommand(path: string): WorkbenchCommand {
  const normalizedPath = normalizeCommandPath(path);
  return {
    type: "attach",
    attachment: {
      id: `file:${normalizedPath}`,
      kind: "file",
      path: normalizedPath,
      label: normalizedPath,
    },
  };
}

export function renamePathReferencesCommand(
  fromPath: string,
  toPath: string,
  options: { readonly openAffectedBuffer?: boolean } = {},
): WorkbenchCommand {
  return {
    type: "renamePathReferences",
    fromPath,
    toPath,
    openAffectedBuffer: options.openAffectedBuffer,
  };
}

export function deletePathReferencesCommand(
  path: string,
  options: { readonly closeAffectedSurface?: boolean } = {},
): WorkbenchCommand {
  return {
    type: "deletePathReferences",
    path,
    closeAffectedSurface: options.closeAffectedSurface,
  };
}

export function attachFileRangeCommand(
  path: string,
  line: number,
  endLine = line,
): WorkbenchCommand {
  const normalizedPath = normalizeCommandPath(path);
  return {
    type: "attach",
    attachment: {
      id: `file-range:${normalizedPath}:${line}-${endLine}`,
      kind: "file-range",
      path: normalizedPath,
      line,
      endLine,
      label: `${normalizedPath}:${line}${endLine !== line ? `-${endLine}` : ""}`,
    },
  };
}

export function attachSearchMatchCommand(query: string, match: SearchMatch): WorkbenchCommand {
  return {
    type: "attach",
    attachment: searchMatchAttachment(query, match),
  };
}

export function attachTaskErrorCommand(input: {
  readonly taskId: string;
  readonly file: string;
  readonly line?: number;
  readonly label?: string;
}): WorkbenchCommand {
  const file = normalizeCommandPath(input.file);
  return {
    type: "attach",
    attachment: {
      id: `task-error:${input.taskId}:${file}:${input.line ?? 1}`,
      kind: "task-error",
      path: file,
      line: input.line,
      taskId: input.taskId,
      label: normalizePathBackedLabel(
        input.label,
        input.file,
        file,
        `${file}${input.line ? `:${input.line}` : ""}`,
      ),
    },
  };
}

export function attachDiffHunkCommand(input: {
  readonly path: string;
  readonly line?: number;
  readonly label?: string;
}): WorkbenchCommand {
  const path = normalizeCommandPath(input.path);
  return {
    type: "attach",
    attachment: {
      id: `diff-hunk:${path}:${input.line ?? 1}`,
      kind: "diff-hunk",
      path,
      line: input.line,
      label: normalizePathBackedLabel(
        input.label,
        input.path,
        path,
        `${path}${input.line ? `:${input.line}` : ""}`,
      ),
    },
  };
}

export function searchMatchAttachment(query: string, match: SearchMatch): WorkbenchAttachment {
  const file = normalizeCommandPath(match.file);
  return {
    id: `search-result:${replaceFirst(match.id, match.file, file)}`,
    kind: "search-result",
    path: file,
    line: match.line,
    query,
    label: `${file}:${match.line}`,
  };
}

export function attachmentPromptMention(attachment: WorkbenchAttachment): string | null {
  if (!attachment.path) return null;
  const path = normalizeCommandPath(attachment.path);
  switch (attachment.kind) {
    case "file":
      return `@${path}`;
    case "file-range":
      return `@${path}#L${attachment.line ?? 1}${attachment.endLine && attachment.endLine !== attachment.line ? `-${attachment.endLine}` : ""}`;
    case "search-result":
    case "diff-hunk":
    case "task-error":
      return `@${path}${attachment.line ? `#L${attachment.line}` : ""}`;
    case "editor-selection":
    case "editor-diagnostic":
      // These carry an exact live-buffer snapshot. Turning them into @path
      // would make a dirty selection silently resolve to stale disk bytes.
      return null;
  }
}

export function materializeAttachmentMentions(
  input: string,
  attachments: readonly WorkbenchAttachment[],
): string {
  const existingMentions = new Set(input.split(/\s+/u).filter((token) => token.startsWith("@")));
  const mentions = attachments
    .map(attachmentPromptMention)
    .filter((mention): mention is string => mention !== null)
    .filter((mention, index, allMentions) =>
      allMentions.indexOf(mention) === index && !existingMentions.has(mention)
    );
  if (mentions.length === 0) return input;
  return `${mentions.join(" ")}\n\n${input}`;
}

export function bufferIntegrationIntentCommand(
  intent: BufferIntegrationIntent,
): WorkbenchCommand {
  const context = intent.context;
  const path = normalizeCommandPath(context.path);
  const displayPath = path || "[No Name]";
  const attachmentIdentity = path || `buffer-${context.bufferHandle}`;
  const startLine = Math.max(1, context.range.start.line);
  const endLine = Math.max(startLine, context.range.end.line);
  const kind = context.kind === "diagnostic"
    ? "editor-diagnostic"
    : "editor-selection";
  const attachment: WorkbenchAttachment = {
    id: [
      kind,
      attachmentIdentity,
      `${startLine}:${Math.max(0, context.range.start.column)}`,
      `${endLine}:${Math.max(0, context.range.end.column)}`,
      context.changedtick,
    ].join(":"),
    kind,
    label: `${displayPath}:${startLine}${endLine === startLine ? "" : `-${endLine}`}`,
    ...(path ? { path } : {}),
    line: startLine,
    endLine,
    startColumn: Math.max(0, context.range.start.column),
    endColumn: Math.max(0, context.range.end.column),
    content: context.content,
    dirty: context.dirty,
    selectionMode: context.selectionMode,
    changedtick: context.changedtick,
    diagnostic: context.diagnostic
      ? {
          message: context.diagnostic.message,
          ...(context.diagnostic.severity !== null
            ? { severity: String(context.diagnostic.severity) }
            : {}),
          ...(context.diagnostic.source
            ? { source: context.diagnostic.source }
            : {}),
          ...(context.diagnostic.code !== undefined
            ? { code: String(context.diagnostic.code) }
            : {}),
        }
      : undefined,
  };
  return {
    type: "handoffToComposer",
    attachment,
    draftText: integrationDraft(intent),
    openTranscriptRail: intent.kind !== "attach",
  };
}

function integrationDraft(intent: BufferIntegrationIntent): string | undefined {
  const explicit = intent.prompt?.trim();
  if (explicit) return explicit;
  switch (intent.kind) {
    case "attach":
      return undefined;
    case "ask":
      return undefined;
    case "fix":
      return "Fix the attached issue.";
    case "explain":
      return "Explain the attached code.";
    case "review":
      return "Review the attached editor context.";
  }
}

function normalizeCommandPath(path: string): string {
  return normalizeWorkspacePathForReferences(path);
}

function normalizePathBackedLabel(
  label: string | undefined,
  originalPath: string,
  normalizedPath: string,
  defaultLabel: string,
): string {
  if (label === undefined) return defaultLabel;
  return replaceFirst(label, originalPath, normalizedPath);
}

function replaceFirst(value: string, needle: string, replacement: string): string {
  if (!needle || needle === replacement) return value;
  const index = value.indexOf(needle);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}
