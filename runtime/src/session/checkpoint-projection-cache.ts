import { types } from "node:util";
import type { LLMMessage } from "../llm/types.js";
import type { ResponseItem } from "./rollout-item.js";
import type {
  PersistedToolResultIdentity,
  ToolResultBodyIdentity,
} from "./tool-result-integrity.js";

const MAX_ENTRIES = 256;
const MAX_RETAINED_CODE_UNITS = 131_072;
const MAX_CONTENT_CODE_UNITS = 32_768;
const MESSAGE_KEYS = ["role", "content", "toolCallId", "toolName", "phase", "runtimeOnly"];
const MESSAGE_READS = [...MESSAGE_KEYS, "toolCalls", "providerReasoningContent", "providerReasoningProvenance"];
const RUNTIME_KEYS = ["toolResultIntegrity", "responseItemId"];
const RUNTIME_READS = [...RUNTIME_KEYS, "agentInvocation", "compactionHistory"];
// Full projection preserves seal insertion order in JSONL. Admit only the
// creator's order, including after same-value replacement or delete/reinsert.
const INTEGRITY_KEYS = ["version", "algorithm", "runId", "toolCallId", "resultId", "original", "persisted"];
const ORIGINAL_KEYS = ["digest", "byteLength"];
const PERSISTED_KEYS = ["representation", "digest", "byteLength"];

interface Snapshot {
  readonly content: string;
  readonly callId: string;
  readonly toolName: string | undefined;
  readonly phase: string | undefined;
  readonly responseId: string | undefined;
  readonly runId: string;
  readonly integrityCallId: string;
  readonly resultId: string;
  readonly originalDigest: string;
  readonly originalBytes: number;
  readonly persistedDigest: string;
  readonly persistedBytes: number;
  readonly representation: string;
}

/** Only this transient value may refer to the mutable source seal. */
interface Candidate {
  readonly snapshot: Snapshot;
  readonly original: ToolResultBodyIdentity;
  readonly persisted: PersistedToolResultIdentity;
}

interface Proof {
  readonly snapshot: Snapshot;
  readonly owner: WeakRef<LLMMessage>;
  readonly codeUnits: number;
}

/**
 * Reuse only clean, bounded text-tool projections after comparing every current
 * input value. The sanitizer must remain a pure function of its fixed rules;
 * a future configurable policy needs a revision here or must disable reuse.
 * No source graph or returned projection is retained by the proof table.
 */
export function withCheckpointProjectionCache(
  project: (message: LLMMessage) => ResponseItem,
): (message: LLMMessage) => ResponseItem {
  const lookup = new WeakMap<LLMMessage, object>();
  const proofs = new Map<object, Proof>();
  let retainedCodeUnits = 0;
  const remove = (token: object): void => {
    const proof = proofs.get(token);
    if (proof === undefined) return;
    const owner = proof.owner.deref();
    if (owner !== undefined && lookup.get(owner) === token) lookup.delete(owner);
    proofs.delete(token);
    retainedCodeUnits -= proof.codeUnits;
  };

  return (message) => {
    const candidate = capture(message);
    const token = lookup.get(message);
    const proof = token === undefined ? undefined : proofs.get(token);
    if (candidate !== undefined && token !== undefined && proof !== undefined &&
        equalSnapshots(candidate.snapshot, proof.snapshot)) {
      proofs.delete(token);
      proofs.set(token, proof);
      return materialize(candidate);
    }
    if (token !== undefined) remove(token);

    // A miss always performs the existing authentication, redaction and exact
    // serializer-based line check. Neither failures nor altered output is kept.
    const projected = project(message);
    if (candidate === undefined ||
        JSON.stringify(projected) !== JSON.stringify(materialize(candidate))) {
      return projected;
    }
    // Count snapshot strings twice, conservatively allowing a second owned
    // representation. Never count mutable source objects as bounded storage.
    const codeUnits = Object.values(candidate.snapshot).reduce<number>(
      (sum, value) => sum + (typeof value === "string" ? value.length * 2 : 0), 0,
    );
    if (codeUnits > MAX_RETAINED_CODE_UNITS) return projected;
    while (proofs.size >= MAX_ENTRIES ||
           retainedCodeUnits + codeUnits > MAX_RETAINED_CODE_UNITS) {
      const oldest = proofs.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
    }
    const nextToken = {};
    proofs.set(nextToken, {
      snapshot: candidate.snapshot,
      owner: new WeakRef(message),
      codeUnits,
    });
    retainedCodeUnits += codeUnits;
    lookup.set(message, nextToken);
    return projected;
  };
}

type Descriptors = Record<string, PropertyDescriptor>;

/** Reflection must not invoke a getter or proxy trap before the full fallback. */
function dataProperties(
  value: unknown,
  allowed: readonly string[],
  reads: readonly string[] = allowed,
  ordered = false,
): Descriptors | undefined {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || "toJSON" in value) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return undefined;
  if (ordered && (keys.length !== allowed.length ||
      keys.some((key, index) => key !== allowed[index]))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    const descriptor = descriptors[key as string]!;
    return !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
  })) return undefined;
  if (reads.some((key) => !Object.hasOwn(descriptors, key) && key in value)) return undefined;
  return descriptors;
}

function ownValue(descriptors: Descriptors, key: string): unknown {
  return Object.hasOwn(descriptors, key) ? descriptors[key]!.value : undefined;
}

function optionalString(descriptors: Descriptors, key: string): boolean {
  return !Object.hasOwn(descriptors, key) || typeof ownValue(descriptors, key) === "string";
}

function capture(message: LLMMessage): Candidate | undefined {
  const fields = dataProperties(message, MESSAGE_KEYS, MESSAGE_READS);
  if (fields === undefined || ownValue(fields, "role") !== "tool") return undefined;
  const content = ownValue(fields, "content");
  const callId = ownValue(fields, "toolCallId");
  if (typeof content !== "string" || content.length > MAX_CONTENT_CODE_UNITS ||
      typeof callId !== "string" || !optionalString(fields, "toolName") ||
      !optionalString(fields, "phase")) return undefined;
  const runtime = dataProperties(ownValue(fields, "runtimeOnly"), RUNTIME_KEYS, RUNTIME_READS);
  if (runtime === undefined || !optionalString(runtime, "responseItemId")) return undefined;
  const integrity = dataProperties(ownValue(runtime, "toolResultIntegrity"), INTEGRITY_KEYS, INTEGRITY_KEYS, true);
  if (integrity === undefined || ownValue(integrity, "version") !== 1 ||
      ownValue(integrity, "algorithm") !== "sha256") return undefined;
  const originalValue = ownValue(integrity, "original");
  const persistedValue = ownValue(integrity, "persisted");
  const original = dataProperties(originalValue, ORIGINAL_KEYS, ORIGINAL_KEYS, true);
  const persisted = dataProperties(persistedValue, PERSISTED_KEYS, PERSISTED_KEYS, true);
  if (original === undefined || persisted === undefined) return undefined;
  const runId = ownValue(integrity, "runId");
  const integrityCallId = ownValue(integrity, "toolCallId");
  const resultId = ownValue(integrity, "resultId");
  const originalDigest = ownValue(original, "digest");
  const originalBytes = ownValue(original, "byteLength");
  const persistedDigest = ownValue(persisted, "digest");
  const persistedBytes = ownValue(persisted, "byteLength");
  const representation = ownValue(persisted, "representation");
  if (typeof runId !== "string" || typeof integrityCallId !== "string" ||
      typeof resultId !== "string" || typeof originalDigest !== "string" ||
      typeof persistedDigest !== "string" || typeof representation !== "string" ||
      typeof originalBytes !== "number" || typeof persistedBytes !== "number") return undefined;
  return {
    snapshot: {
      content, callId,
      toolName: ownValue(fields, "toolName") as string | undefined,
      phase: ownValue(fields, "phase") as string | undefined,
      responseId: ownValue(runtime, "responseItemId") as string | undefined,
      runId, integrityCallId, resultId, originalDigest, originalBytes,
      persistedDigest, persistedBytes, representation,
    },
    original: originalValue as ToolResultBodyIdentity,
    persisted: persistedValue as PersistedToolResultIdentity,
  };
}

function equalSnapshots(left: Snapshot, right: Snapshot): boolean {
  return left.content === right.content && left.callId === right.callId &&
    left.toolName === right.toolName && left.phase === right.phase &&
    left.responseId === right.responseId && left.runId === right.runId &&
    left.integrityCallId === right.integrityCallId && left.resultId === right.resultId &&
    left.originalDigest === right.originalDigest && left.originalBytes === right.originalBytes &&
    left.persistedDigest === right.persistedDigest && left.persistedBytes === right.persistedBytes &&
    left.representation === right.representation;
}

/** Match the ordinary projector's key order and its current nested seal aliases. */
function materialize({ snapshot: value, original, persisted }: Candidate): ResponseItem {
  return {
    role: "tool", content: value.content,
    ...(value.responseId !== undefined ? { id: value.responseId } : {}),
    toolCallId: value.callId,
    ...(value.toolName !== undefined ? { toolName: value.toolName } : {}),
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    toolResultIntegrity: {
      version: 1, algorithm: "sha256", runId: value.runId,
      toolCallId: value.integrityCallId, resultId: value.resultId, original, persisted,
    },
  };
}
