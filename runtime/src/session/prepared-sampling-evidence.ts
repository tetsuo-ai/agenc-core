/** Opt-in semantic preparation evidence, not a wire/admission receipt. */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { StreamModelRequestContract } from "../phases/stream-model.js";
import type { AttachmentAssemblyEvidence } from "../prompts/attachments/assembly-evidence.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_ITEMS = 4_096;
const nativePromiseThen = Promise.prototype.then;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Codec v1: tagged JSON primitives/arrays and sorted [key,value] object entries.
 * Undefined is a distinct tag, including explicit optional properties. Absent
 * keys, null, -0 and undefined remain distinct. Only finite Unicode scalar
 * strings/numbers and plain data objects/dense arrays are supported. Never
 * invokes getters, toJSON, or proxy traps; proxies are unsupported evidence.
 * Keys sort by UTF-16 code units; numbers use ECMAScript String(number), with
 * -0 encoded as the string "-0". JSON.stringify is used only on primitive
 * scalar strings. SHA-256 covers UTF-8 bytes prefixed prepared-semantic-v1:.
 * Hashes are NOT confidential (low-entropy values can be guessed).
 */
export function preparedSemanticDigest(value: unknown): string {
  const hash = createHash("sha256");
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new Error("unsupported evidence");
    hash.update(text);
  };
  const string = (text: string) => {
    if (text.length > MAX_BYTES || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
      throw new Error("unsupported evidence");
    }
    emit(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 32) throw new Error("unsupported evidence");
    if (item === undefined) { emit('["undefined"]'); return; }
    if (item === null) { emit('["null"]'); return; }
    if (typeof item === "string") { emit('["string",'); string(item); emit("]"); return; }
    if (typeof item === "boolean") { emit(item ? '["boolean",true]' : '["boolean",false]'); return; }
    if (typeof item === "number" && Number.isFinite(item)) {
      emit(`["number",${Object.is(item, -0) ? '"-0"' : String(item)}]`); return;
    }
    if (typeof item !== "object" || utilTypes.isProxy(item) || active.has(item)) throw new Error("unsupported evidence");
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("unsupported evidence");
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES || keys.some(key => typeof key !== "string")) throw new Error("unsupported evidence");
    active.add(item);
    if (array) {
      if (item.length > MAX_NODES || keys.length !== item.length + 1) throw new Error("unsupported evidence");
      emit('["array",[');
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("unsupported evidence");
        if (i) emit(","); visit(descriptor.value, depth + 1);
      }
      emit("]]");
    } else {
      emit('["object",[');
      (keys as string[]).sort().forEach((key, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("unsupported evidence");
        if (i) emit(","); emit("["); string(key); emit(","); visit(descriptor.value, depth + 1); emit("]");
      });
      emit("]]");
    }
    active.delete(item);
  };
  emit("prepared-semantic-v1:"); visit(value, 0);
  return hash.digest("hex");
}

/** Internal same-invocation facts; never passed directly to the validator. */
export interface PreparedSamplingFacts {
  readonly turnId: string;
  readonly rootHumanTurn: { readonly turnId: string; readonly text: string } | null;
  readonly sourceMessageCount: number;
  readonly preAttachmentMessageCount: number;
  readonly retainedAttachmentBlocks: number;
  readonly retainedAttachmentMessages: number;
  readonly rawAttachmentOutputs: number;
  readonly assembly: AttachmentAssemblyEvidence | undefined;
}

export interface PreparedSamplingDetails {
  readonly requestDigest: string;
  readonly instructionsDigest: string;
  readonly root: Readonly<{ present: boolean; matchesActiveTurn: boolean; turnDigest: string | null; textDigest: string | null }>;
  readonly counts: Readonly<{ sourceMessages: number; preAttachmentMessages: number; retainedBlocks: number; retainedMessages: number; rawAttachmentOutputs: number }>;
  readonly assembly: AttachmentAssemblyEvidence;
  readonly messages: readonly Readonly<{ role: "system" | "developer" | "user" | "assistant" | "tool"; contentForm: "text" | "parts"; digest: string }>[];
  readonly tools: readonly Readonly<{ nameDigest: string; definitionDigest: string }>[];
  /** Exact semantic presence/value digests; not later effective wire settings. */
  readonly fields: readonly Readonly<{ field: string; present: boolean; digest: string | null }>[];
}
export interface PreparedSamplingEvidence {
  readonly schemaVersion: 1;
  readonly digestCodec: "prepared-semantic-v1";
  /** Existing source-generated snapshot UUID only, not an arbitrary caller ID. */
  readonly managedRequestId: string | null;
  /** Completeness of the bounded semantic encoding, NOT producer success. */
  readonly inventory: "complete" | "unknown";
  readonly unknownReason: "unsupported_or_oversized_semantics" | null;
  readonly details: PreparedSamplingDetails | null;
}
export type PreparedSamplingValidator = (report: PreparedSamplingEvidence) => undefined;
const FIELDS = ["parallelToolCalls", "toolChoice", "contextWindowTokens", "maxOutputTokens", "skipCacheWrite", "lightReasoningEffort", "openaiReasoningReplay"] as const;
const REQUEST_KEYS = new Set<string>(["managedRequestId", "input", "tools", "baseInstructions", ...FIELDS]);
const MESSAGE_KEYS = new Set(["role", "content", "providerReasoningContent", "providerReasoningProvenance", "phase", "runtimeOnly", "toolCalls", "toolCallId", "toolName"]);

export function buildPreparedSamplingEvidence(request: StreamModelRequestContract, facts: PreparedSamplingFacts): PreparedSamplingEvidence {
  let managedRequestId: string | null = null;
  try {
    // Validate entire input before reading properties/projection. Bounded and
    // descriptor-only traversal refuses proxies/accessors even in unused data.
    const requestDigest = preparedSemanticDigest(request);
    preparedSemanticDigest(facts);
    if (typeof request.managedRequestId !== "string" || !UUID.test(request.managedRequestId)) throw new Error();
    managedRequestId = request.managedRequestId;
    if (Object.keys(request).some(key => !REQUEST_KEYS.has(key)) || !facts.assembly ||
        !Array.isArray(request.input) || !Array.isArray(request.tools) || request.input.length > MAX_ITEMS || request.tools.length > MAX_ITEMS ||
        typeof request.baseInstructions !== "string" || typeof request.parallelToolCalls !== "boolean") throw new Error();
    const counts = Object.freeze({ sourceMessages: facts.sourceMessageCount, preAttachmentMessages: facts.preAttachmentMessageCount,
      retainedBlocks: facts.retainedAttachmentBlocks, retainedMessages: facts.retainedAttachmentMessages, rawAttachmentOutputs: facts.rawAttachmentOutputs });
    if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error();
    const root = facts.rootHumanTurn;
    if (typeof facts.turnId !== "string" || (root !== null && (typeof root.turnId !== "string" || typeof root.text !== "string"))) throw new Error();
    const messages = request.input.map(message => {
      const role = message.role;
      if (!["system", "developer", "user", "assistant", "tool"].includes(role) ||
          Object.keys(message).some(key => !MESSAGE_KEYS.has(key)) ||
          (typeof message.content !== "string" && !Array.isArray(message.content))) throw new Error();
      if (Array.isArray(message.content) && message.content.some((part: unknown) =>
        part === null || typeof part !== "object" || !("type" in part) || typeof part.type !== "string" ||
        !["text", "image_url", "document"].includes(part.type))) throw new Error();
      return Object.freeze({ role, contentForm: typeof message.content === "string" ? "text" as const : "parts" as const, digest: preparedSemanticDigest(message) });
    });
    const tools = request.tools.map(tool => {
      if (tool.type !== "function" || typeof tool.function.name !== "string" ||
          Object.keys(tool).some(key => key !== "type" && key !== "function") ||
          Object.keys(tool.function).some(key => !["name", "description", "parameters"].includes(key))) throw new Error();
      return Object.freeze({ nameDigest: preparedSemanticDigest(tool.function.name), definitionDigest: preparedSemanticDigest(tool) });
    });
    // Phase1 data is already frozen, but detach again: this API exposes no
    // producer-owned reference even if a future internal collector changes.
    const assembly: AttachmentAssemblyEvidence = Object.freeze({ ...facts.assembly, outcomes: Object.freeze(facts.assembly.outcomes.map(outcome =>
      Object.freeze({ ...outcome, outputKinds: outcome.outputKinds === null ? null : Object.freeze([...outcome.outputKinds]) }))) });
    const details: PreparedSamplingDetails = Object.freeze({ requestDigest, instructionsDigest: preparedSemanticDigest(request.baseInstructions), counts, assembly,
      root: Object.freeze({ present: root !== null, matchesActiveTurn: root !== null && root.turnId === facts.turnId,
        turnDigest: root === null ? null : preparedSemanticDigest(root.turnId), textDigest: root === null ? null : preparedSemanticDigest(root.text) }),
      messages: Object.freeze(messages), tools: Object.freeze(tools), fields: Object.freeze(FIELDS.map(field => {
        const present = Object.hasOwn(request, field);
        return Object.freeze({ field, present, digest: present ? preparedSemanticDigest(request[field]) : null });
      })) });
    return Object.freeze({ schemaVersion: 1, digestCodec: "prepared-semantic-v1", managedRequestId, inventory: "complete", unknownReason: null, details });
  } catch {
    return Object.freeze({ schemaVersion: 1, digestCodec: "prepared-semantic-v1", managedRequestId, inventory: "unknown",
      unknownReason: "unsupported_or_oversized_semantics", details: null });
  }
}

export class PreparedSamplingValidationError extends Error {
  readonly code = "prepared_sampling_validation_failed";
  constructor() { super("Prepared sampling validation failed"); this.name = "PreparedSamplingValidationError"; }
}

/** Trusted synchronous gate. Cancellation keeps its original reason. */
export function validatePreparedSamplingEvidence(report: PreparedSamplingEvidence, validator: PreparedSamplingValidator, signal: AbortSignal): void {
  signal.throwIfAborted();
  try {
    const returned: unknown = validator(report);
    if (utilTypes.isPromise(returned)) {
      // Captured intrinsic, trusted species boundary; never assimilate thenables.
      Reflect.apply(nativePromiseThen, returned, [undefined, () => {}]);
      throw new PreparedSamplingValidationError();
    }
    if (returned !== undefined) throw new PreparedSamplingValidationError();
  } catch {
    signal.throwIfAborted();
    throw new PreparedSamplingValidationError();
  }
  signal.throwIfAborted();
}
