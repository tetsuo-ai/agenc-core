import type { SearchMatch, WorkbenchAttachment, WorkbenchCommand } from "./types.js";

export function openPreviewCommand(
  path: string,
  line?: number,
  focus = true,
): WorkbenchCommand {
  return { type: "openPreview", path, line, focus };
}

export function openBufferCommand(
  path: string,
  line?: number,
  focus = true,
): WorkbenchCommand {
  return { type: "openBuffer", path, line, focus };
}

export function attachFileCommand(path: string): WorkbenchCommand {
  return {
    type: "attach",
    attachment: {
      id: `file:${path}`,
      kind: "file",
      path,
      label: path,
    },
  };
}

export function renamePathReferencesCommand(fromPath: string, toPath: string): WorkbenchCommand {
  return { type: "renamePathReferences", fromPath, toPath };
}

export function deletePathReferencesCommand(path: string): WorkbenchCommand {
  return { type: "deletePathReferences", path };
}

export function attachFileRangeCommand(
  path: string,
  line: number,
  endLine = line,
): WorkbenchCommand {
  return {
    type: "attach",
    attachment: {
      id: `file-range:${path}:${line}-${endLine}`,
      kind: "file-range",
      path,
      line,
      endLine,
      label: `${path}:${line}${endLine !== line ? `-${endLine}` : ""}`,
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
  return {
    type: "attach",
    attachment: {
      id: `task-error:${input.taskId}:${input.file}:${input.line ?? 1}`,
      kind: "task-error",
      path: input.file,
      line: input.line,
      taskId: input.taskId,
      label: input.label ?? `${input.file}${input.line ? `:${input.line}` : ""}`,
    },
  };
}

export function attachDiffHunkCommand(input: {
  readonly path: string;
  readonly line?: number;
  readonly label?: string;
}): WorkbenchCommand {
  return {
    type: "attach",
    attachment: {
      id: `diff-hunk:${input.path}:${input.line ?? 1}`,
      kind: "diff-hunk",
      path: input.path,
      line: input.line,
      label: input.label ?? `${input.path}${input.line ? `:${input.line}` : ""}`,
    },
  };
}

export function searchMatchAttachment(query: string, match: SearchMatch): WorkbenchAttachment {
  return {
    id: `search-result:${match.id}`,
    kind: "search-result",
    path: match.file,
    line: match.line,
    query,
    label: `${match.file}:${match.line}`,
  };
}

export function attachmentPromptMention(attachment: WorkbenchAttachment): string | null {
  if (!attachment.path) return null;
  switch (attachment.kind) {
    case "file":
      return `@${attachment.path}`;
    case "file-range":
      return `@${attachment.path}#L${attachment.line ?? 1}${attachment.endLine && attachment.endLine !== attachment.line ? `-${attachment.endLine}` : ""}`;
    case "search-result":
    case "diff-hunk":
    case "task-error":
      return `@${attachment.path}${attachment.line ? `#L${attachment.line}` : ""}`;
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
