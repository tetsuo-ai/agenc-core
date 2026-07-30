/**
 * `EditorProposal` — a non-mutating terminal for revisioned editor turns.
 *
 * The tool is registered as deferred and is advertised only by the turn
 * kernel while an editor interaction is running in `proposal_only` mode.
 * It never edits a buffer or the filesystem. The trusted runtime validates
 * the returned path/revision against the interaction snapshot before the TUI
 * is allowed to render the proposal.
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export const EDITOR_PROPOSAL_TOOL_NAME = "EditorProposal";
export const EDITOR_PROPOSAL_SCHEMA_VERSION = 1;
const MAX_EDITOR_PROPOSAL_TEXT_BYTES = 8 * 1024 * 1024;

export interface EditorProposalTextEdit {
  readonly id: string;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
  readonly old_text: string;
  readonly new_text: string;
}

export interface EditorProposalPayload {
  readonly version: typeof EDITOR_PROPOSAL_SCHEMA_VERSION;
  readonly interaction_id: string;
  readonly path: string;
  readonly buffer_handle: number;
  readonly base_changedtick: number;
  readonly base_content_sha256: string;
  /**
   * Optional exact end-of-line state used by daemon-coordinated whole-buffer
   * proposals. Model-authored EditorProposal calls omit these fields.
   */
  readonly base_end_of_line?: boolean;
  readonly new_end_of_line?: boolean;
  readonly summary: string;
  readonly edits: readonly EditorProposalTextEdit[];
}

const POSITION_SCHEMA = {
  type: "integer",
  minimum: 0,
} as const;

const LINE_SCHEMA = {
  type: "integer",
  minimum: 1,
} as const;

export function createEditorProposalTool(): Tool {
  return {
    name: EDITOR_PROPOSAL_TOOL_NAME,
    description:
      "Return a revisioned shadow edit for the active AgenC Editor interaction. " +
      "This tool never changes the file or editor. Call it exactly once after " +
      "you have inspected the supplied editor context and can provide exact " +
      "old_text/new_text replacements against that snapshot.",
    metadata: {
      family: "editor",
      source: "builtin",
      hiddenByDefault: true,
      deferred: true,
      mutating: false,
      keywords: ["editor", "proposal", "patch", "inline"],
      preferredProfiles: ["coding"],
    },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: {
          type: "integer",
          const: EDITOR_PROPOSAL_SCHEMA_VERSION,
        },
        interaction_id: { type: "string", minLength: 1 },
        path: { type: "string" },
        buffer_handle: { type: "integer", minimum: 1 },
        base_changedtick: { type: "integer", minimum: 0 },
        base_content_sha256: {
          type: "string",
          pattern: "^[a-fA-F0-9]{64}$",
        },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128 },
              start_line: LINE_SCHEMA,
              start_column: POSITION_SCHEMA,
              end_line: LINE_SCHEMA,
              end_column: POSITION_SCHEMA,
              old_text: { type: "string", maxLength: 262_144 },
              new_text: { type: "string", maxLength: 262_144 },
            },
            required: [
              "id",
              "start_line",
              "start_column",
              "end_line",
              "end_column",
              "old_text",
              "new_text",
            ],
          },
        },
      },
      required: [
        "version",
        "interaction_id",
        "path",
        "buffer_handle",
        "base_changedtick",
        "base_content_sha256",
        "summary",
        "edits",
      ],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const validationError = validateEditorProposalPayload(args);
      if (validationError !== null) {
        return {
          content: safeStringify({
            error: validationError,
          }),
          isError: true,
        };
      }
      const proposal = args as unknown as EditorProposalPayload;
      return {
        content: safeStringify({
          message: "Editor proposal provided successfully",
          proposal_id: `${proposal.interaction_id}:${proposal.base_changedtick}`,
        }),
        metadata: {
          editorProposal: proposal as unknown as Record<string, unknown>,
        },
      };
    },
  };
}

export function validateEditorProposalPayload(
  value: Record<string, unknown>,
  options: {
    readonly allowReservedEndOfLineState?: boolean;
  } = {},
): string | null {
  if (value.version !== EDITOR_PROPOSAL_SCHEMA_VERSION) {
    return `version must be ${EDITOR_PROPOSAL_SCHEMA_VERSION}`;
  }
  if (!nonEmptyString(value.interaction_id)) {
    return "interaction_id must be a non-empty string";
  }
  if (typeof value.path !== "string") {
    return "path must be a string";
  }
  if (!positiveInteger(value.buffer_handle)) {
    return "buffer_handle must be a positive integer";
  }
  if (!nonNegativeInteger(value.base_changedtick)) {
    return "base_changedtick must be a non-negative integer";
  }
  if (
    typeof value.base_content_sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/u.test(value.base_content_sha256)
  ) {
    return "base_content_sha256 must be a SHA-256 hex digest";
  }
  const hasReservedEndOfLineState =
    value.base_end_of_line !== undefined || value.new_end_of_line !== undefined;
  if (hasReservedEndOfLineState) {
    if (options.allowReservedEndOfLineState !== true) {
      return "base_end_of_line and new_end_of_line are reserved for trusted daemon proposals";
    }
    if (typeof value.base_end_of_line !== "boolean") {
      return "base_end_of_line must be a boolean";
    }
    if (typeof value.new_end_of_line !== "boolean") {
      return "new_end_of_line must be a boolean";
    }
  }
  if (!nonEmptyString(value.summary) || value.summary.length > 2_000) {
    return "summary must be a non-empty string of at most 2000 characters";
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    return "edits must contain at least one edit";
  }
  if (value.edits.length > 200) {
    return "edits may contain at most 200 entries";
  }
  const seen = new Set<string>();
  const validatedEdits: Array<{
    readonly index: number;
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  }> = [];
  let proposalTextBytes = 0;
  for (const [index, raw] of value.edits.entries()) {
    if (!isRecord(raw)) return `edits[${index}] must be an object`;
    if (!nonEmptyString(raw.id) || raw.id.length > 128) {
      return `edits[${index}].id must contain 1-128 characters`;
    }
    if (seen.has(raw.id)) return `edits[${index}].id must be unique`;
    seen.add(raw.id);
    if (!positiveInteger(raw.start_line)) {
      return `edits[${index}].start_line must be a positive integer`;
    }
    if (!nonNegativeInteger(raw.start_column)) {
      return `edits[${index}].start_column must be a non-negative integer`;
    }
    if (!positiveInteger(raw.end_line)) {
      return `edits[${index}].end_line must be a positive integer`;
    }
    if (!nonNegativeInteger(raw.end_column)) {
      return `edits[${index}].end_column must be a non-negative integer`;
    }
    if (
      raw.end_line < raw.start_line ||
      (raw.end_line === raw.start_line && raw.end_column < raw.start_column)
    ) {
      return `edits[${index}] has an inverted range`;
    }
    if (typeof raw.old_text !== "string") {
      return `edits[${index}].old_text must be a string`;
    }
    if (typeof raw.new_text !== "string") {
      return `edits[${index}].new_text must be a string`;
    }
    if (raw.old_text.length > 262_144) {
      return `edits[${index}].old_text exceeds 262144 characters`;
    }
    if (raw.new_text.length > 262_144) {
      return `edits[${index}].new_text exceeds 262144 characters`;
    }
    proposalTextBytes +=
      Buffer.byteLength(raw.old_text, "utf8") +
      Buffer.byteLength(raw.new_text, "utf8");
    if (proposalTextBytes > MAX_EDITOR_PROPOSAL_TEXT_BYTES) {
      return `proposal edit text exceeds ${MAX_EDITOR_PROPOSAL_TEXT_BYTES} UTF-8 bytes`;
    }
    if (
      raw.old_text === raw.new_text &&
      value.base_end_of_line === value.new_end_of_line
    ) {
      return `edits[${index}] does not change the content`;
    }
    validatedEdits.push({
      index,
      startLine: raw.start_line,
      startColumn: raw.start_column,
      endLine: raw.end_line,
      endColumn: raw.end_column,
    });
  }
  validatedEdits.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.startColumn - right.startColumn ||
      left.endLine - right.endLine ||
      left.endColumn - right.endColumn,
  );
  for (let index = 1; index < validatedEdits.length; index += 1) {
    const previous = validatedEdits[index - 1]!;
    const current = validatedEdits[index]!;
    if (
      (previous.startLine === current.startLine &&
        previous.startColumn === current.startColumn) ||
      positionAfter(
        previous.endLine,
        previous.endColumn,
        current.startLine,
        current.startColumn,
      )
    ) {
      return `edits[${current.index}] overlaps or shares an ambiguous start position`;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function positionAfter(
  leftLine: number,
  leftColumn: number,
  rightLine: number,
  rightColumn: number,
): boolean {
  return (
    leftLine > rightLine || (leftLine === rightLine && leftColumn > rightColumn)
  );
}
