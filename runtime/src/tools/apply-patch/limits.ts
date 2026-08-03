const BYTES_PER_KIBIBYTE = 1_024;
const KIBIBYTES_PER_MEBIBYTE = 1_024;
const BYTES_PER_MEBIBYTE = BYTES_PER_KIBIBYTE * KIBIBYTES_PER_MEBIBYTE;

/** Maximum accepted UTF-8 patch payload. */
export const MAX_APPLY_PATCH_BYTES = 16 * BYTES_PER_MEBIBYTE;

/** Maximum number of logical lines in one patch payload. */
export const MAX_APPLY_PATCH_LINES = 1_000_000;

/** Maximum UTF-8 size of one patch or source line. */
export const MAX_APPLY_PATCH_LINE_BYTES = BYTES_PER_MEBIBYTE;

/** Maximum number of file hunks in one patch transaction. */
export const MAX_APPLY_PATCH_HUNKS = 100_000;

/** Maximum number of update chunks in one patch transaction. */
export const MAX_APPLY_PATCH_CHUNKS = 200_000;

/** Maximum accepted source-file and generated-output size. */
export const MAX_APPLY_PATCH_FILE_BYTES = 64 * BYTES_PER_MEBIBYTE;

/** Maximum logical lines accepted from one source file. */
export const MAX_APPLY_PATCH_FILE_LINES = 1_000_000;

/** Source lines plus patch-added lines can coexist in generated output. */
export const MAX_APPLY_PATCH_OUTPUT_LINES =
  MAX_APPLY_PATCH_FILE_LINES + MAX_APPLY_PATCH_LINES;

/** Fixed allocation used by descriptor-bound bounded file reads. */
export const APPLY_PATCH_FILE_READ_CHUNK_BYTES = 64 * BYTES_PER_KIBIBYTE;

/**
 * Shared normalization/comparison budget for one patch transaction. It is
 * deliberately covers source and pattern normalization at their independent
 * byte limits, while still placing a hard ceiling on adversarial matching.
 */
export const MAX_APPLY_PATCH_MATCH_WORK_UNITS = 384 * BYTES_PER_MEBIBYTE;

/** Cancellation/deadline polling cadence inside synchronous linear scans. */
export const APPLY_PATCH_CONTROL_CHECK_INTERVAL = 1_024;
