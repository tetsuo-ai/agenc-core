/**
 * Ports the donor apply-patch data model onto AgenC tool primitives.
 *
 * Shape differences from upstream:
 *   - Paths are plain strings until the runtime resolves them against
 *     the active workspace root.
 *   - Parse/runtime failures throw Error subclasses instead of returning
 *     a Rust-style result enum.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Shell command interception is left to the later tool-runtime split.
 */

export interface UpdateFileChunk {
  readonly changeContext: string | null;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly isEndOfFile: boolean;
}

export type ApplyPatchHunk =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly contents: string;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly movePath: string | null;
      readonly chunks: readonly UpdateFileChunk[];
    };

export interface ApplyPatchArgs {
  readonly patch: string;
  readonly hunks: readonly ApplyPatchHunk[];
  readonly workdir: string | null;
}

export interface AffectedPaths {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

export interface AppliedPatch {
  readonly originalContents: string;
  readonly newContents: string;
}

export interface ApplyPatchFileUpdate {
  readonly unifiedDiff: string;
  readonly content: string;
}

export type ParseErrorKind = "invalid_patch" | "invalid_hunk";

export class ApplyPatchParseError extends Error {
  readonly kind: ParseErrorKind;
  readonly lineNumber: number | null;

  constructor(
    kind: ParseErrorKind,
    message: string,
    lineNumber: number | null = null,
  ) {
    super(
      kind === "invalid_hunk" && lineNumber !== null
        ? `invalid hunk at line ${lineNumber}, ${message}`
        : `invalid patch: ${message}`,
    );
    this.name = "ApplyPatchParseError";
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

export class ApplyPatchRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyPatchRuntimeError";
  }
}
