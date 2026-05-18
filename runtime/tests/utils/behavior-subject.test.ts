import { describe, expect, test } from "vitest";
import { BehaviorSubject } from "./behavior-subject.js";

describe("BehaviorSubject", () => {
  test("happy path: subscribe replays current; next pushes updates", () => {
    const subj = new BehaviorSubject(0);
    const seen: number[] = [];
    const unsub = subj.subscribe((v) => seen.push(v));
    expect(seen).toEqual([0]);
    subj.next(1);
    subj.next(2);
    expect(seen).toEqual([0, 1, 2]);
    unsub();
    subj.next(3);
    expect(seen).toEqual([0, 1, 2]);
  });

  test("multiple subscribers each get the current value + subsequent next()", () => {
    const subj = new BehaviorSubject("a");
    const aSeen: string[] = [];
    const bSeen: string[] = [];
    subj.subscribe((v) => aSeen.push(v));
    subj.subscribe((v) => bSeen.push(v));
    subj.next("b");
    expect(aSeen).toEqual(["a", "b"]);
    expect(bSeen).toEqual(["a", "b"]);
  });

  test("complete makes future next() a no-op", () => {
    const subj = new BehaviorSubject(0);
    const seen: number[] = [];
    subj.subscribe((v) => seen.push(v));
    subj.next(1);
    subj.complete();
    expect(subj.isClosed).toBe(true);
    subj.next(2);
    expect(seen).toEqual([0, 1]);
  });

  test("value getter always returns the latest value", () => {
    const subj = new BehaviorSubject({ count: 0 });
    expect(subj.value.count).toBe(0);
    subj.next({ count: 5 });
    expect(subj.value.count).toBe(5);
  });
});
