/**
 * Utility exports for @tetsuo-ai/runtime.
 *
 * Post-gut: Solana-flavored utilities (pda, treasury, token) were
 * deleted. Only portable helpers remain.
 *
 * @module
 */

export { sleep, toErrorMessage, SEVEN_DAYS_MS } from "./async.js";

export { type Logger, type LogLevel, createLogger, silentLogger } from "./logger.js";

export {
  generateAgentId,
  hexToBytes,
  bytesToHex,
  agentIdFromString,
  agentIdToString,
  agentIdToShortString,
  agentIdsEqual,
  bigintsToProofHash,
  proofHashToBigints,
  toAnchorBytes,
  toUint8Array,
  uint8ToBase64,
  base64ToUint8,
  fnv1aHash,
  fnv1aHashUnit,
  fnv1aHashHex,
} from "./encoding.js";

export { encodeStatusByte, queryWithFallback } from "./query.js";

export { ensureLazyModule } from "./lazy-import.js";

export {
  runCommand,
  type RunCommandOptions,
  type RunCommandResult,
} from "./process.js";

export { isRecord, isStringArray } from "./type-guards.js";

export { groupBy } from "./collections.js";

export {
  clamp01,
  clampRatio,
  clampInteger,
  nonNegative,
} from "./numeric.js";

export type { ValidationResult } from "./validation.js";

export {
  validationResult,
  requireNonEmptyString,
  requireFiniteNumber,
  requireOneOf,
  requireIntRange,
} from "./validation.js";
