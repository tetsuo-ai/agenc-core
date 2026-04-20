/**
 * Memory subsystem barrel — public exports for T10 Group C.
 *
 * @module
 */

export {
  MEMORY_TYPES,
  parseMemoryType,
  parseFrontmatter,
  serializeMemory,
  type MemoryType,
  type MemoryFrontmatter,
  type MemoryEntry,
} from "./types.js";

export {
  scanMemoryDir,
  scanMemoryIndex,
  MAX_MEMORY_FILES,
  MAX_MEMORY_BYTES,
  MAX_SCAN_DEPTH,
  ENTRYPOINT_NAME,
  type ScanResult,
} from "./scan.js";

export {
  loadMemoryPrompt,
  getMemoryWriteLock,
  DEFAULT_MEMORY_MAX_LINES,
  DEFAULT_MEMORY_MAX_BYTES,
  _clearMemoryWriteLocksForTest,
  _memoryWriteLocksForTest,
  type LoadMemoryOpts,
  type LoadedMemory,
} from "./loader.js";

export {
  maybeAutoSaveMemory,
  registerAutoSaveSidecar,
  writeMemoryFile,
  upsertIndexEntry,
  shouldExtract,
  isMemoryWorthy,
  stubExtractor,
  AUTO_SAVE_MIN_TOKEN_GROWTH,
  AUTO_SAVE_MIN_TOOL_CALLS,
  _resetAutoSaveStateForTest,
  type AutoSaveSession,
  type TurnState,
  type MemoryCandidate,
  type ExtractMemoriesFn,
} from "./auto-save.js";

export {
  selectRelevantMemoriesForTurn,
  injectAttachmentsIntoPrompt,
  scoreMemory,
  attachmentBudgetFor,
  ATTACHMENT_MAX_FILES_PER_TURN,
  ATTACHMENT_MAX_BYTES_PER_FILE,
  ATTACHMENT_MAX_BYTES_PER_SESSION,
} from "./attachments.js";
