import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import type { LLMMessage } from "../llm/types.js";
import {
  createExecutionEnvelope,
  type ExecutionEnvelope,
} from "../workflow/execution-envelope.js";
import {
  isPathWithinRoot,
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import type { SessionReadSeedEntry } from "../tools/system/filesystem.js";

const AT_MENTION_MAX_SIZE_BYTES = 256 * 1024;

interface AtMentionedFileLines {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ResolvedAtMentionAttachments {
  readonly historyPrelude: readonly LLMMessage[];
  readonly sourceArtifacts: readonly string[];
  readonly readSeeds: readonly SessionReadSeedEntry[];
  readonly executionEnvelope?: ExecutionEnvelope;
}

export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g;
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g;

  const quotedMatches: string[] = [];
  const regularMatches: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(" (agent)")) {
      quotedMatches.push(match[2]);
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || [];
  regularMatchArray.forEach((value) => {
    const filename = value.slice(value.indexOf("@") + 1);
    if (!filename.startsWith("\"")) {
      regularMatches.push(filename);
    }
  });

  return [...new Set([...quotedMatches, ...regularMatches])];
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/);

  if (!match) {
    return { filename: mention };
  }

  const [, filename, lineStartStr, lineEndStr] = match;
  const lineStart = lineStartStr ? Number.parseInt(lineStartStr, 10) : undefined;
  const lineEnd = lineEndStr ? Number.parseInt(lineEndStr, 10) : lineStart;

  return { filename: filename ?? mention, lineStart, lineEnd };
}

function buildToolPrelude(params: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly toolResult: Record<string, unknown>;
}): readonly LLMMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: params.toolCallId,
          name: params.toolName,
          arguments: JSON.stringify(params.toolArgs),
        },
      ],
    },
    {
      role: "tool",
      content: JSON.stringify(params.toolResult),
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    },
  ];
}

export async function resolveAtMentionAttachments(params: {
  readonly content: string;
  readonly workspaceRoot?: string;
}): Promise<ResolvedAtMentionAttachments> {
  const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
  if (!workspaceRoot) {
    return {
      historyPrelude: [],
      sourceArtifacts: [],
      readSeeds: [],
    };
  }

  const mentions = extractAtMentionedFiles(params.content);
  if (mentions.length === 0) {
    return {
      historyPrelude: [],
      sourceArtifacts: [],
      readSeeds: [],
    };
  }

  const historyPrelude: LLMMessage[] = [];
  const sourceArtifacts: string[] = [];
  const readSeeds: SessionReadSeedEntry[] = [];
  const seenArtifactKeys = new Set<string>();

  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index]!;
    const parsed = parseAtMentionedFileLines(mention);
    const canonicalPath = normalizeArtifactPaths(
      [parsed.filename],
      workspaceRoot,
    )[0];
    if (!canonicalPath) continue;
    if (!isPathWithinRoot(canonicalPath, workspaceRoot)) continue;
    if (!existsSync(canonicalPath)) continue;

    let fileStats;
    try {
      fileStats = await stat(canonicalPath);
    } catch {
      continue;
    }
    if (!fileStats.isFile()) continue;
    if (fileStats.size > AT_MENTION_MAX_SIZE_BYTES) {
      continue;
    }

    const artifactKey = `${canonicalPath}:${parsed.lineStart ?? 0}:${parsed.lineEnd ?? 0}`;
    if (seenArtifactKeys.has(artifactKey)) {
      continue;
    }
    seenArtifactKeys.add(artifactKey);

    let text: string;
    try {
      text = await readFile(canonicalPath, "utf8");
    } catch {
      continue;
    }

    const toolCallId = `at_mention_file_${index + 1}`;
    if (typeof parsed.lineStart === "number") {
      const lines = text.split(/\r?\n/u);
      const startLine = Math.max(1, parsed.lineStart);
      const endLine = Math.max(startLine, parsed.lineEnd ?? parsed.lineStart);
      const selected = lines.slice(startLine - 1, endLine);
      historyPrelude.push(
        ...buildToolPrelude({
          toolCallId,
          toolName: "system.readFileRange",
          toolArgs: {
            path: canonicalPath,
            startLine,
            endLine,
          },
          toolResult: {
            path: canonicalPath,
            startLine,
            endLine,
            lines: selected.map((line, lineIndex) => ({
              line: startLine + lineIndex,
              text: line,
            })),
          },
        }),
      );
      readSeeds.push({
        path: canonicalPath,
        content: selected.join("\n"),
        timestamp: fileStats.mtimeMs,
        viewKind: "partial",
      });
    } else {
      historyPrelude.push(
        ...buildToolPrelude({
          toolCallId,
          toolName: "system.readFile",
          toolArgs: {
            path: canonicalPath,
          },
          toolResult: {
            path: canonicalPath,
            size: Buffer.byteLength(text, "utf8"),
            encoding: "utf-8",
            content: text,
          },
        }),
      );
      readSeeds.push({
        path: canonicalPath,
        content: text,
        timestamp: fileStats.mtimeMs,
        viewKind: "full",
      });
    }

    if (!sourceArtifacts.includes(canonicalPath)) {
      sourceArtifacts.push(canonicalPath);
    }
  }

  return {
    historyPrelude,
    sourceArtifacts,
    readSeeds,
    executionEnvelope: createExecutionEnvelope({
      workspaceRoot,
      allowedReadRoots: [workspaceRoot],
      inputArtifacts: sourceArtifacts,
      requiredSourceArtifacts: sourceArtifacts,
    }),
  };
}
