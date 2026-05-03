export {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  EOF_MARKER,
  MOVE_TO_MARKER,
  UPDATE_FILE_MARKER,
  parsePatch,
  type ParseMode,
} from "./parser.js";

export {
  applyHunksToFiles,
  applyParsedPatch,
  applyPatchText,
  applyReplacements,
  computeReplacements,
  deriveNewContentsFromChunks,
  printSummary,
  unifiedDiffFromChunks,
  type ApplyPatchResult,
  type ApplyPatchRuntimeOptions,
} from "./runtime.js";

export {
  APPLY_PATCH_LARK_GRAMMAR,
  APPLY_PATCH_TOOL_NAME,
  createApplyPatchTool,
  type ApplyPatchToolConfig,
} from "./tool.js";

export type {
  AffectedPaths,
  AppliedPatch,
  ApplyPatchAction,
  ApplyPatchArgs,
  ApplyPatchFileChange,
  ApplyPatchFileUpdate,
  ApplyPatchHunk,
  UpdateFileChunk,
} from "./types.js";

export {
  ApplyPatchParseError,
  ApplyPatchRuntimeError,
} from "./types.js";
