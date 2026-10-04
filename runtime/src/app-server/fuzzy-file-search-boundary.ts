/** Shared RPC validation without loading the file index or search engine. */
export const MAX_FUZZY_QUERY_CODEPOINTS = 256;
export const MAX_FUZZY_RAW_ROOTS = 64;
export const MAX_FUZZY_RESULTS = 1_000;
export const MAX_FUZZY_FILE_ROOTS_UTF8_BYTES = 262_144;
export const MAX_FUZZY_FILE_ROOT_UTF8_BYTES = 16_384;

export type FuzzyFileSearchBoundaryReason =
  | "QUERY_LIMIT"
  | "QUERY_ENCODING"
  | "RAW_ROOT_COUNT_LIMIT"
  | "UNAUTHORIZED_ROOT"
  | "ROOT_PATH_LIMIT"
  | "ROOT_BYTES_LIMIT"
  | "ROOT_COUNT_LIMIT"
  | "RESULT_LIMIT"
  | "REFRESH_FLAG"
  | "CACHE_LIMIT"
  | "TRAVERSAL_LIMIT"
  | "BUILD_QUEUE_LIMIT";

export class FuzzyFileSearchBoundaryError extends Error {
  constructor(
    readonly reason: FuzzyFileSearchBoundaryReason,
    message: string,
  ) {
    super(message);
    this.name = "FuzzyFileSearchBoundaryError";
  }
}

