import { types } from "node:util";
import type { LLMMessage } from "../llm/types.js";
import {
  computeCheckpointPrefixHashV4FromRecords,
  positionCheckpointPrefixRecordV4,
  recordCheckpointPrefixMessageV4,
  validateCheckpointPrefixInvocationSequenceV4,
  type CheckpointPrefixRecordV4,
  type PositionedCheckpointPrefixRecordV4,
} from "./durable-checkpoint-reader.js";
import {
  captureCheckpointMessage,
  createCheckpointMessageProjector,
} from "./message-history-conversion.js";
import type { ResponseItem } from "./rollout-item.js";
import type { ToolResultIntegrity } from "./tool-result-integrity.js";

/**
 * Incremental checkpoint prefix digests for one session.
 *
 * A turn checkpoint authenticates the durable history prefix with the v4
 * prefix digest. Computing that digest from scratch projects, redacts,
 * validates and encodes every message of the conversation again, twice per
 * tool round, so the cost of each tool round grows with the session. This
 * tracker does that work once per message and replays the recorded canonical
 * bytes for every later checkpoint, across turns as well.
 *
 * Exactness: an entry is reused only for a message whose own data (every key
 * and every leaf value, recursively) still equals the snapshot taken when the
 * entry's projection input was fixed. Projection, redaction (fixed rules), the
 * seal requirement, the shape gate and the record are pure functions of that
 * data, so a reused record is the record a full recomputation produces now,
 * and the digest is byte-identical to computeCheckpointPrefixHashV4 over the
 * full projection. Key order is not part of that data: every gate reads named
 * fields or compares key sets, and the digest writes named fields. Messages
 * that are not plain data, and inputs that share a tool-result seal still
 * being filled by an earlier persistence job, are never reused. A message is
 * looked up by identity first, then at its previous position, because each
 * turn starts from rebuilt copies of the history.
 */
export class CheckpointPrefixTracker {
  readonly #entries = new WeakMap<LLMMessage, PrefixEntry>();
  readonly #project = createCheckpointMessageProjector();
  #previousMessages: readonly LLMMessage[] = [];
  #previousEntries: readonly PrefixEntry[] = [];
  #lastDigest: { readonly records: readonly PositionedCheckpointPrefixRecordV4[]; readonly prefixHash: string } | undefined;

  /**
   * Fix the durable prefix of one checkpoint. When `deferring`, the digest is
   * built later by the write-behind queue, so new and changed messages are
   * captured now exactly as the full writer captures them; otherwise the build
   * reads the live messages, as the full writer does.
   */
  capture(
    messages: readonly LLMMessage[],
    options: CheckpointPrefixCaptureOptions,
  ): CheckpointPrefixCapture {
    const list = Array.from(messages);
    if (!options.deferring) {
      return new CheckpointPrefixCapture(() => this.#build(this.#resolve(list, options), options));
    }
    const entries = this.#resolve(list, options);
    return new CheckpointPrefixCapture(() => this.#build(entries, options));
  }

  #resolve(
    messages: readonly LLMMessage[],
    options: CheckpointPrefixCaptureOptions,
  ): PrefixEntry[] {
    const entries: PrefixEntry[] = new Array<PrefixEntry>(messages.length);
    const previousMessages = this.#previousMessages;
    const previousEntries = this.#previousEntries;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      let entry = previousMessages[index] === message ? previousEntries[index] : this.#entries.get(message);
      let keyed = entry !== undefined;
      entry ??= previousEntries[index];
      if (entry === undefined || !reusable(message, entry)) {
        entry = createEntry(message, options);
        keyed = false;
      }
      if (!keyed) {
        if (entry.snapshot === undefined) this.#entries.delete(message);
        else this.#entries.set(message, entry);
      }
      entries[index] = entry;
    }
    this.#previousMessages = messages;
    this.#previousEntries = entries;
    return entries;
  }

  #build(
    entries: readonly PrefixEntry[],
    options: CheckpointPrefixCaptureOptions,
  ): CheckpointPrefixDigest {
    // The same gate order as the full writer: project every message, require
    // every seal, check the invocation sequence, then shape and encode each
    // message. Reused entries passed every gate when they were recorded.
    const pending: Array<{ readonly entry: PrefixEntry; readonly index: number; readonly item: ResponseItem }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.record !== undefined) continue;
      const input = entry.input;
      if (input === undefined) throw new Error("checkpoint prefix entry lost its projection input");
      // A record built from a seal another job has yet to fill is not the
      // record of the message's current data; it serves this checkpoint only.
      if (carriesPendingSeal(input, options)) entry.snapshot = undefined;
      pending.push({ entry, index, item: this.#project(input) });
    }
    for (const { item } of pending) requireSealedToolResult(item);
    for (const { entry, item } of pending) entry.sequence = sequenceView(item);
    if (entries.some((entry) => entry.sequence!.relevant)) {
      validateCheckpointPrefixInvocationSequenceV4(entries.map((entry) => entry.sequence!.item));
    }
    for (const { entry, index, item } of pending) {
      entry.record = recordCheckpointPrefixMessageV4(item, index);
      entry.input = undefined;
    }
    const records: PositionedCheckpointPrefixRecordV4[] = new Array<PositionedCheckpointPrefixRecordV4>(entries.length);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      let positioned = entry.positioned;
      if (positioned?.index !== index) {
        positioned = positionCheckpointPrefixRecordV4(entry.record!, index);
        entry.positioned = positioned;
      }
      records[index] = positioned;
    }
    // A checkpoint taken before the next model sample often repeats the
    // previous prefix exactly; the digest is a function of these records.
    const last = this.#lastDigest;
    const prefixHash = last !== undefined && sameRecords(last.records, records)
      ? last.prefixHash
      : computeCheckpointPrefixHashV4FromRecords(records);
    this.#lastDigest = { records, prefixHash };
    return { prefixHash, persistedMessageCount: records.length, projectedMessages: pending.length };
  }
}

export interface CheckpointPrefixCaptureOptions {
  /** True when the checkpoint event is built later by the write-behind queue. */
  readonly deferring: boolean;
  /** True for a seal whose persisted identity an earlier queued job fills. */
  readonly pendingIntegrity: (integrity: ToolResultIntegrity) => boolean;
}

export interface CheckpointPrefixDigest {
  readonly prefixHash: string;
  readonly persistedMessageCount: number;
  /** Messages projected and encoded for this checkpoint (the rest reused). */
  readonly projectedMessages: number;
}

/** One checkpoint's prefix; `build` runs at most once and caches its result. */
export class CheckpointPrefixCapture {
  #result: CheckpointPrefixDigest | undefined;
  readonly #build: () => CheckpointPrefixDigest;

  constructor(build: () => CheckpointPrefixDigest) {
    this.#build = build;
  }

  build(): CheckpointPrefixDigest {
    this.#result ??= this.#build();
    return this.#result;
  }
}

const trackers = new WeakMap<object, CheckpointPrefixTracker>();

/** The tracker shared by every turn of one session object. */
export function checkpointPrefixTrackerFor(owner: object): CheckpointPrefixTracker {
  let tracker = trackers.get(owner);
  if (tracker === undefined) {
    tracker = new CheckpointPrefixTracker();
    trackers.set(owner, tracker);
  }
  return tracker;
}

interface PrefixEntry {
  /** Leaf snapshot when the input was fixed; undefined: never reuse. */
  snapshot: readonly unknown[] | undefined;
  /** Projection input until the record exists: the message or its capture. */
  input: LLMMessage | undefined;
  record: CheckpointPrefixRecordV4 | undefined;
  positioned: PositionedCheckpointPrefixRecordV4 | undefined;
  sequence: SequenceView | undefined;
}

function createEntry(
  message: LLMMessage,
  options: CheckpointPrefixCaptureOptions,
): PrefixEntry {
  let input = message;
  let snapshot = snapshotMessage(message);
  if (options.deferring) {
    // Exactly the full writer's capture: the private seal still being filled
    // by the preceding response-item job is shared, everything else cloned.
    const integrity = message.runtimeOnly?.toolResultIntegrity;
    const pending = integrity !== undefined && options.pendingIntegrity(integrity);
    input = captureCheckpointMessage(message, pending ? integrity : undefined);
    if (pending) snapshot = undefined;
  }
  return {
    snapshot,
    input,
    record: undefined,
    positioned: undefined,
    sequence: undefined,
  };
}

function sameRecords(
  left: readonly PositionedCheckpointPrefixRecordV4[],
  right: readonly PositionedCheckpointPrefixRecordV4[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function carriesPendingSeal(
  message: LLMMessage,
  options: CheckpointPrefixCaptureOptions,
): boolean {
  const integrity = message.runtimeOnly?.toolResultIntegrity;
  return integrity !== undefined && options.pendingIntegrity(integrity);
}

function requireSealedToolResult(message: ResponseItem): void {
  if (message.role === "tool" && message.toolResultIntegrity === undefined) {
    throw new Error("checkpoint v2 requires every tool result to be sealed");
  }
}

interface SequenceView {
  /** What the invocation-sequence gate needs from this message. */
  readonly item: Pick<ResponseItem, "role" | "content" | "agentInvocation">;
  /** False when the gate can only accept this message. */
  readonly relevant: boolean;
}

/**
 * A message without invocation metadata only takes part in the sequence gate
 * through its content check. When that check passes once, an empty body is an
 * exact stand-in and the projected body is not retained.
 */
function sequenceView(item: ResponseItem): SequenceView {
  if (item.agentInvocation !== undefined) {
    return {
      item: { role: item.role, content: item.content, agentInvocation: item.agentInvocation },
      relevant: true,
    };
  }
  try {
    validateCheckpointPrefixInvocationSequenceV4([{ role: item.role, content: item.content }]);
  } catch {
    return { item: { role: item.role, content: item.content }, relevant: true };
  }
  return { item: { role: item.role, content: "" }, relevant: false };
}

const SNAPSHOT_OBJECT = Object.freeze({});
const SNAPSHOT_ARRAY = Object.freeze({});
const MAX_SNAPSHOT_SLOTS = 4_096;
const MAX_SNAPSHOT_DEPTH = 16;

/** Every key and leaf of plain data, in own-key order; undefined otherwise. */
function snapshotMessage(message: LLMMessage): unknown[] | undefined {
  const slots: unknown[] = [];
  return appendSnapshot(message, slots, 0) ? slots : undefined;
}

function appendSnapshot(value: unknown, slots: unknown[], depth: number): boolean {
  if (slots.length >= MAX_SNAPSHOT_SLOTS) return false;
  if (typeof value !== "object" || value === null) {
    if (typeof value === "function" || typeof value === "symbol") return false;
    slots.push(value);
    return true;
  }
  if (depth >= MAX_SNAPSHOT_DEPTH || types.isProxy(value)) return false;
  const keys = Object.keys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length) return false;
    slots.push(SNAPSHOT_ARRAY, value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      if (!appendSnapshot(descriptor.value, slots, depth + 1)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  slots.push(SNAPSHOT_OBJECT, keys.length);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) return false;
    slots.push(key);
    if (!appendSnapshot(descriptor.value, slots, depth + 1)) return false;
  }
  return true;
}

/** True when `message` holds the data of `entry`; adopts its key order. */
function reusable(message: LLMMessage, entry: PrefixEntry): boolean {
  const snapshot = entry.snapshot;
  if (snapshot === undefined) return false;
  if (compareSnapshot(message, snapshot, 0) === snapshot.length) return true;
  if (!equalIgnoringKeyOrder(message, decodeSnapshot(snapshot, 0)[0])) return false;
  const current = snapshotMessage(message);
  if (current === undefined) return false;
  entry.snapshot = current;
  return true;
}

type SnapshotNode =
  | { readonly kind: "leaf"; readonly value: unknown }
  | { readonly kind: "array"; readonly items: readonly SnapshotNode[] }
  | { readonly kind: "object"; readonly fields: ReadonlyMap<string, SnapshotNode> };

function decodeSnapshot(snapshot: readonly unknown[], cursor: number): [SnapshotNode, number] {
  const slot = snapshot[cursor];
  if (slot === SNAPSHOT_ARRAY) {
    const items: SnapshotNode[] = [];
    let next = cursor + 2;
    for (let index = 0; index < (snapshot[cursor + 1] as number); index += 1) {
      const [item, after] = decodeSnapshot(snapshot, next);
      items.push(item);
      next = after;
    }
    return [{ kind: "array", items }, next];
  }
  if (slot === SNAPSHOT_OBJECT) {
    const fields = new Map<string, SnapshotNode>();
    let next = cursor + 2;
    for (let index = 0; index < (snapshot[cursor + 1] as number); index += 1) {
      const [field, after] = decodeSnapshot(snapshot, next + 1);
      fields.set(snapshot[next] as string, field);
      next = after;
    }
    return [{ kind: "object", fields }, next];
  }
  return [{ kind: "leaf", value: slot }, cursor + 1];
}

function equalIgnoringKeyOrder(value: unknown, node: SnapshotNode): boolean {
  if (typeof value !== "object" || value === null) return node.kind === "leaf" && node.value === value;
  if (node.kind === "array") {
    return Array.isArray(value) && value.length === node.items.length &&
      node.items.every((item, index) => equalIgnoringKeyOrder(value[index], item));
  }
  if (node.kind !== "object" || Array.isArray(value)) return false;
  let seen = 0;
  for (const key in value) {
    const field = node.fields.get(key);
    if (field === undefined || !equalIgnoringKeyOrder((value as Record<string, unknown>)[key], field)) return false;
    seen += 1;
  }
  return seen === node.fields.size;
}

/** Returns the cursor after `value`, or -1 at the first difference. */
function compareSnapshot(value: unknown, snapshot: readonly unknown[], cursor: number): number {
  if (typeof value !== "object" || value === null) {
    return snapshot[cursor] === value ? cursor + 1 : -1;
  }
  if (Array.isArray(value)) {
    if (snapshot[cursor] !== SNAPSHOT_ARRAY || snapshot[cursor + 1] !== value.length) return -1;
    let next = cursor + 2;
    for (let index = 0; index < value.length; index += 1) {
      next = compareSnapshot(value[index], snapshot, next);
      if (next < 0) return -1;
    }
    return next;
  }
  if (snapshot[cursor] !== SNAPSHOT_OBJECT) return -1;
  const count = snapshot[cursor + 1] as number;
  let next = cursor + 2;
  let seen = 0;
  for (const key in value) {
    if (seen === count || snapshot[next] !== key) return -1;
    next = compareSnapshot((value as Record<string, unknown>)[key], snapshot, next + 1);
    if (next < 0) return -1;
    seen += 1;
  }
  return seen === count ? next : -1;
}
