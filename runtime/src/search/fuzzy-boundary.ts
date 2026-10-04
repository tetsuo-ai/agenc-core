/** Text boundaries shared by the matcher and RPC admission. */
export const MAX_FUZZY_QUERY_UTF8_BYTES = 262_144;
export const MAX_FUZZY_QUERY_CODE_POINTS = 65_535;
export const MAX_FUZZY_CANDIDATE_UTF8_BYTES = 262_144;
export const MAX_FUZZY_CANDIDATE_CODE_POINTS = 65_535;

const UTF16_HIGH_SURROGATE_START = 0xd800;
const UTF16_HIGH_SURROGATE_END = 0xdbff;
const UTF16_LOW_SURROGATE_START = 0xdc00;
const UTF16_LOW_SURROGATE_END = 0xdfff;
const BYTE_NUL = 0x00;

export type FuzzyBoundaryReason =
  | "EMPTY_QUERY"
  | "TEXT_NUL"
  | "TEXT_LONE_SURROGATE"
  | "QUERY_BYTE_LIMIT"
  | "QUERY_CODE_POINT_LIMIT"
  | "CANDIDATE_BYTE_LIMIT"
  | "CANDIDATE_CODE_POINT_LIMIT"
  | "MATRIX_LIMIT"
  | "CANDIDATE_COUNT_LIMIT"
  | "CANDIDATE_TOTAL_BYTE_LIMIT"
  | "RESULT_LIMIT";

export class FuzzyBoundaryError extends Error {
  readonly reason: FuzzyBoundaryReason;

  constructor(reason: FuzzyBoundaryReason, message: string) {
    super(message);
    this.name = "FuzzyBoundaryError";
    this.reason = reason;
  }
}


export function validateFuzzyQuery(query: string): void {
  validateTextEncoding(query, "fuzzy query");
  if (query.length === 0) {
    throw new FuzzyBoundaryError(
      "EMPTY_QUERY",
      "fuzzy query must not be empty",
    );
  }
  const bytes = Buffer.byteLength(query, "utf8");
  if (bytes > MAX_FUZZY_QUERY_UTF8_BYTES) {
    throw new FuzzyBoundaryError(
      "QUERY_BYTE_LIMIT",
      `fuzzy query is ${bytes} UTF-8 bytes; maximum is ${MAX_FUZZY_QUERY_UTF8_BYTES}`,
    );
  }
  const codePoints = Array.from(query).length;
  if (codePoints > MAX_FUZZY_QUERY_CODE_POINTS) {
    throw new FuzzyBoundaryError(
      "QUERY_CODE_POINT_LIMIT",
      `fuzzy query has ${codePoints} code points; maximum is ${MAX_FUZZY_QUERY_CODE_POINTS}`,
    );
  }
}

export function validateFuzzyCandidate(candidate: string): number {
  validateTextEncoding(candidate, "fuzzy candidate");
  const bytes = Buffer.byteLength(candidate, "utf8");
  if (bytes > MAX_FUZZY_CANDIDATE_UTF8_BYTES) {
    throw new FuzzyBoundaryError(
      "CANDIDATE_BYTE_LIMIT",
      `fuzzy candidate is ${bytes} UTF-8 bytes; maximum is ${MAX_FUZZY_CANDIDATE_UTF8_BYTES}`,
    );
  }
  const codePoints = Array.from(candidate).length;
  if (codePoints > MAX_FUZZY_CANDIDATE_CODE_POINTS) {
    throw new FuzzyBoundaryError(
      "CANDIDATE_CODE_POINT_LIMIT",
      `fuzzy candidate has ${codePoints} code points; maximum is ${MAX_FUZZY_CANDIDATE_CODE_POINTS}`,
    );
  }
  return bytes;
}


function validateTextEncoding(value: string, label: string): void {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === BYTE_NUL) {
      throw new FuzzyBoundaryError(
        "TEXT_NUL",
        `${label} contains an embedded NUL`,
      );
    }
    if (
      codeUnit >= UTF16_HIGH_SURROGATE_START &&
      codeUnit <= UTF16_HIGH_SURROGATE_END
    ) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < UTF16_LOW_SURROGATE_START ||
        following > UTF16_LOW_SURROGATE_END
      ) {
        throw new FuzzyBoundaryError(
          "TEXT_LONE_SURROGATE",
          `${label} contains a lone UTF-16 high surrogate`,
        );
      }
      index += 1;
      continue;
    }
    if (
      codeUnit >= UTF16_LOW_SURROGATE_START &&
      codeUnit <= UTF16_LOW_SURROGATE_END
    ) {
      throw new FuzzyBoundaryError(
        "TEXT_LONE_SURROGATE",
        `${label} contains a lone UTF-16 low surrogate`,
      );
    }
  }
}

const FUZZY_SIGNATURE_WORDS = 8;

