import { Buffer } from "node:buffer";
import { isAbsolute, normalize } from "node:path";

export const MAX_AUTHORITY_PATH_BYTES = 4096;

/** Validate an exact operator-supplied path without redirecting it by trimming. */
export function normalizeExactAbsolutePath(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  if (value.trim() !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_AUTHORITY_PATH_BYTES) {
    throw new Error(
      `${label} must not exceed ${MAX_AUTHORITY_PATH_BYTES} UTF-8 bytes`,
    );
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return normalize(value);
}
