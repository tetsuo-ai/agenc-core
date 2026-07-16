import { gunzipSync } from "node:zlib";
import { decodeStrictJson } from "../eval-pilot/safe-io.js";
import { EvalExecutorError } from "./source-lock.js";
import {
  EVAL_EXECUTOR_MAXIMUM_ARTIFACT_BYTES,
  VERIFIER_BUNDLE_KIND,
  VERIFIER_BUNDLE_VERSION,
  type VerifierBundle,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCommandList(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new EvalExecutorError([`${label} must be an array of non-empty strings`]);
  }
  return value as readonly string[];
}

function assertTestNameList(value: unknown, label: string): readonly string[] {
  const entries = assertCommandList(value, label);
  if (new Set(entries).size !== entries.length) {
    throw new EvalExecutorError([`${label} must not contain duplicate test names`]);
  }
  return entries;
}

/**
 * Decode a gzip-compressed `agenc.eval.swe-bench-live-verifier-bundle` CAS
 * artifact. Decompression is bounded to the pilot artifact limit so a
 * corrupted or hostile blob cannot balloon in memory.
 */
export function decodeVerifierBundle(compressed: Uint8Array, expectedInstanceId: string): VerifierBundle {
  let bytes: Buffer;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: EVAL_EXECUTOR_MAXIMUM_ARTIFACT_BYTES });
  } catch (error) {
    throw new EvalExecutorError([
      `verifier bundle for ${expectedInstanceId} failed bounded gunzip: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  const value = decodeStrictJson(bytes, `verifier bundle for ${expectedInstanceId}`);
  if (!isRecord(value)) {
    throw new EvalExecutorError([`verifier bundle for ${expectedInstanceId} must be a JSON object`]);
  }
  if (value.kind !== VERIFIER_BUNDLE_KIND) {
    throw new EvalExecutorError([
      `verifier bundle for ${expectedInstanceId} kind must be ${VERIFIER_BUNDLE_KIND}`,
    ]);
  }
  if (value.version !== VERIFIER_BUNDLE_VERSION) {
    throw new EvalExecutorError([
      `verifier bundle for ${expectedInstanceId} version must be ${VERIFIER_BUNDLE_VERSION}`,
    ]);
  }
  if (value.instanceId !== expectedInstanceId) {
    throw new EvalExecutorError([
      `verifier bundle instanceId ${String(value.instanceId)} does not match task ${expectedInstanceId}`,
    ]);
  }
  if (typeof value.testPatch !== "string") {
    throw new EvalExecutorError([`verifier bundle for ${expectedInstanceId} testPatch must be a string`]);
  }
  if (typeof value.logParser !== "string" || value.logParser.length === 0) {
    throw new EvalExecutorError([
      `verifier bundle for ${expectedInstanceId} logParser must be a non-empty string`,
    ]);
  }
  const failToPass = assertTestNameList(value.failToPass, "failToPass");
  if (failToPass.length === 0) {
    throw new EvalExecutorError([
      `verifier bundle for ${expectedInstanceId} failToPass must not be empty`,
    ]);
  }
  return {
    kind: VERIFIER_BUNDLE_KIND,
    version: VERIFIER_BUNDLE_VERSION,
    instanceId: expectedInstanceId,
    testPatch: value.testPatch,
    rebuildCommands: assertCommandList(value.rebuildCommands, "rebuildCommands"),
    testCommands: assertCommandList(value.testCommands, "testCommands"),
    printCommands: assertCommandList(value.printCommands, "printCommands"),
    logParser: value.logParser,
    failToPass,
    passToPass: assertTestNameList(value.passToPass, "passToPass"),
  };
}
