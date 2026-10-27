import { expect, test } from "vitest";
import {
  matchesPlainDataSnapshot,
  matchesPlainDataSnapshotIgnoringKeyOrder,
  snapshotPlainData,
} from "../../src/utils/plain-data-snapshot.js";

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = { n: value };
  return value;
}

test("snapshots plain leaves, arrays and objects in own-key order", () => {
  const value = { a: 1, b: [true, null, "x"], c: undefined };
  const snapshot = snapshotPlainData(value)!;
  expect(snapshotPlainData(1)).toEqual([1]);
  expect(snapshotPlainData(null)).toEqual([null]);
  expect(matchesPlainDataSnapshot(value, snapshot)).toBe(true);
  expect(matchesPlainDataSnapshot({ a: 1, b: [true, null, "x"], c: 0 }, snapshot)).toBe(false);
  expect(matchesPlainDataSnapshot([1], snapshotPlainData([1, 2])!)).toBe(false);
});

test("reordered object keys fail the ordered match and pass the key-order-agnostic one", () => {
  const original = { a: 1, b: { c: 2, d: 3 } };
  const reordered = { b: { d: 3, c: 2 }, a: 1 };
  const snapshot = snapshotPlainData(original)!;
  expect(matchesPlainDataSnapshot(reordered, snapshot)).toBe(false);
  expect(matchesPlainDataSnapshotIgnoringKeyOrder(reordered, snapshot)).toBe(true);
  expect(matchesPlainDataSnapshotIgnoringKeyOrder({ a: 1, b: { c: 2 } }, snapshot)).toBe(false);
  expect(matchesPlainDataSnapshot(original, snapshotPlainData(reordered)!)).toBe(false);
});

test("refuses proxies, functions, symbols, accessors, holes and foreign prototypes", () => {
  expect(snapshotPlainData(() => 1)).toBeUndefined();
  expect(snapshotPlainData(Symbol("x"))).toBeUndefined();
  expect(snapshotPlainData({ fn: () => 1 })).toBeUndefined();
  expect(snapshotPlainData(new Proxy({ a: 1 }, {}))).toBeUndefined();
  expect(snapshotPlainData(new Date())).toBeUndefined();
  expect(snapshotPlainData(Object.defineProperty({}, "a", { get: () => 1, enumerable: true }))).toBeUndefined();
  expect(snapshotPlainData([1, , 3])).toBeUndefined();
  expect(snapshotPlainData(Object.create({ a: 1 }))).toBeUndefined();
  const nullProto = Object.assign(Object.create(null), { a: 1 });
  expect(matchesPlainDataSnapshot(nullProto, snapshotPlainData(nullProto)!)).toBe(true);
});

test("refuses values past the depth and slot bounds", () => {
  expect(snapshotPlainData(nest(16))).toBeDefined();
  expect(snapshotPlainData(nest(17))).toBeUndefined();
  expect(snapshotPlainData(Array.from({ length: 4094 }, (_, i) => i))).toBeDefined();
  expect(snapshotPlainData(Array.from({ length: 4095 }, (_, i) => i))).toBeUndefined();
});
