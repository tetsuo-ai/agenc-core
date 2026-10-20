import { types } from "node:util";

/**
 * Leaf snapshots of plain data, for caches that reuse work derived from a
 * value only while the value still holds the same data.
 *
 * A snapshot lists every key and leaf of a plain-data value in own-key order.
 * It exists only for plain data: objects with the plain or null prototype and
 * arrays without holes, holding data properties (no accessors, no proxies),
 * within a bounded size and depth. Anything a pure function of such a value
 * reads is then fixed by its snapshot.
 */
const SNAPSHOT_OBJECT = Object.freeze({});
const SNAPSHOT_ARRAY = Object.freeze({});
const MAX_SNAPSHOT_SLOTS = 4_096;
const MAX_SNAPSHOT_DEPTH = 16;

export type PlainDataSnapshot = readonly unknown[];

/** Every key and leaf of plain data, in own-key order; undefined otherwise. */
export function snapshotPlainData(value: unknown): unknown[] | undefined {
  const slots: unknown[] = [];
  return appendSnapshot(value, slots, 0) ? slots : undefined;
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

/** True when `value` holds exactly the snapshot's keys, in order, and leaves. */
export function matchesPlainDataSnapshot(value: unknown, snapshot: PlainDataSnapshot): boolean {
  return compareSnapshot(value, snapshot, 0) === snapshot.length;
}

/**
 * True when `value` holds the snapshot's data with its keys in any order. A
 * caller that accepts the value should take a new snapshot of it, so the
 * faster ordered comparison applies the next time.
 */
export function matchesPlainDataSnapshotIgnoringKeyOrder(
  value: unknown,
  snapshot: PlainDataSnapshot,
): boolean {
  return equalIgnoringKeyOrder(value, decodeSnapshot(snapshot, 0)[0]);
}

type SnapshotNode =
  | { readonly kind: "leaf"; readonly value: unknown }
  | { readonly kind: "array"; readonly items: readonly SnapshotNode[] }
  | { readonly kind: "object"; readonly fields: ReadonlyMap<string, SnapshotNode> };

function decodeSnapshot(snapshot: PlainDataSnapshot, cursor: number): [SnapshotNode, number] {
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
function compareSnapshot(value: unknown, snapshot: PlainDataSnapshot, cursor: number): number {
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
