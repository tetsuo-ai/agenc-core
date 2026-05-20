import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applyModalPagerAction,
  computeWheelStep,
  dragScrollDirection,
  initWheelAccel,
  jumpBy,
  modalPagerAction,
  readScrollSpeedBase,
  scrollUp,
  selectionFocusMoveForKey,
  shouldClearSelectionOnKey,
  type ModalPagerAction,
} from "./ScrollKeybindingHandler.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

function makeScrollBox({
  pendingDelta = 0,
  scrollHeight = 100,
  scrollTop = 10,
  viewportHeight = 20,
} = {}) {
  const calls: Array<[string, number?]> = [];
  let top = scrollTop;
  let pending = pendingDelta;

  return {
    calls,
    handle: {
      getPendingDelta: () => pending,
      getScrollHeight: () => scrollHeight,
      getScrollTop: () => top,
      getViewportHeight: () => viewportHeight,
      scrollBy: (amount: number) => {
        calls.push(["scrollBy", amount]);
        pending += amount;
      },
      scrollTo: (value: number) => {
        calls.push(["scrollTo", value]);
        top = value;
        pending = 0;
      },
      scrollToBottom: () => {
        calls.push(["scrollToBottom"]);
        top = Math.max(0, scrollHeight - viewportHeight);
        pending = 0;
      },
    },
  };
}

describe("ScrollKeybindingHandler selection helpers", () => {
  test("clears selection for ordinary keys but preserves wheel and modified navigation", () => {
    expect(shouldClearSelectionOnKey({ wheelUp: true } as never)).toBe(false);
    expect(shouldClearSelectionOnKey({ wheelDown: true } as never)).toBe(false);
    expect(shouldClearSelectionOnKey({ leftArrow: true, shift: true } as never)).toBe(
      false,
    );
    expect(shouldClearSelectionOnKey({ home: true, super: true } as never)).toBe(
      false,
    );
    expect(shouldClearSelectionOnKey({ downArrow: true } as never)).toBe(true);
    expect(shouldClearSelectionOnKey({} as never)).toBe(true);
  });

  test("maps only shift navigation keys to focus moves", () => {
    expect(selectionFocusMoveForKey({ leftArrow: true, shift: true } as never)).toBe(
      "left",
    );
    expect(selectionFocusMoveForKey({ rightArrow: true, shift: true } as never)).toBe(
      "right",
    );
    expect(selectionFocusMoveForKey({ upArrow: true, shift: true } as never)).toBe(
      "up",
    );
    expect(selectionFocusMoveForKey({ downArrow: true, shift: true } as never)).toBe(
      "down",
    );
    expect(selectionFocusMoveForKey({ home: true, shift: true } as never)).toBe(
      "lineStart",
    );
    expect(selectionFocusMoveForKey({ end: true, shift: true } as never)).toBe(
      "lineEnd",
    );
    expect(selectionFocusMoveForKey({ leftArrow: true } as never)).toBeNull();
    expect(selectionFocusMoveForKey({ leftArrow: true, meta: true, shift: true } as never)).toBeNull();
  });
});

describe("ScrollKeybindingHandler wheel acceleration", () => {
  afterEach(() => {
    delete process.env.AGENC_SCROLL_SPEED;
  });

  test("reads and clamps the scroll speed environment override", () => {
    expect(readScrollSpeedBase()).toBe(1);

    process.env.AGENC_SCROLL_SPEED = "3.5";
    expect(readScrollSpeedBase()).toBe(3.5);

    process.env.AGENC_SCROLL_SPEED = "25";
    expect(readScrollSpeedBase()).toBe(20);

    process.env.AGENC_SCROLL_SPEED = "-1";
    expect(readScrollSpeedBase()).toBe(1);

    process.env.AGENC_SCROLL_SPEED = "nope";
    expect(readScrollSpeedBase()).toBe(1);
  });

  test("ramps native wheel events and detects bounce-confirmed wheel mode", () => {
    const state = initWheelAccel(false, 1);

    expect(computeWheelStep(state, 1, 1_000)).toBe(1);
    expect(computeWheelStep(state, 1, 1_010)).toBe(1);
    expect(computeWheelStep(state, 1, 1_020)).toBe(1);
    expect(computeWheelStep(state, 1, 1_030)).toBe(1);
    expect(computeWheelStep(state, 1, 1_040)).toBe(2);

    expect(computeWheelStep(state, -1, 1_050)).toBe(0);
    expect(state.pendingFlip).toBe(true);

    const bouncedStep = computeWheelStep(state, 1, 1_060);
    expect(state.pendingFlip).toBe(false);
    expect(state.wheelMode).toBe(true);
    expect(bouncedStep).toBeGreaterThanOrEqual(3);
  });

  test("commits a real native wheel reversal after the bounce window", () => {
    const state = initWheelAccel(false, 2);
    expect(computeWheelStep(state, 1, 100)).toBe(2);
    expect(computeWheelStep(state, -1, 120)).toBe(0);
    expect(computeWheelStep(state, -1, 400)).toBe(2);
    expect(state.dir).toBe(-1);
    expect(state.wheelMode).toBe(false);
  });

  test("uses xterm.js decay, burst, reversal, and idle behavior", () => {
    const state = initWheelAccel(true, 1);

    expect(computeWheelStep(state, 1, 1_000)).toBe(2);
    expect(computeWheelStep(state, 1, 1_001)).toBe(1);

    const accelerated = computeWheelStep(state, 1, 1_040);
    expect(accelerated).toBeGreaterThanOrEqual(3);

    expect(computeWheelStep(state, -1, 1_060)).toBe(2);
    expect(state.frac).toBe(0);

    expect(computeWheelStep(state, -1, 1_700)).toBe(2);
  });
});

describe("ScrollKeybindingHandler drag and jump helpers", () => {
  test("decides drag autoscroll direction from focus, anchor, and active direction", () => {
    expect(dragScrollDirection(null, 2, 8)).toBe(0);
    expect(
      dragScrollDirection(
        { isDragging: false, anchor: { row: 5 }, focus: { row: 1 } } as never,
        2,
        8,
      ),
    ).toBe(0);
    expect(
      dragScrollDirection(
        { isDragging: true, anchor: { row: 5 }, focus: { row: 1 } } as never,
        2,
        8,
      ),
    ).toBe(-1);
    expect(
      dragScrollDirection(
        { isDragging: true, anchor: { row: 5 }, focus: { row: 9 } } as never,
        2,
        8,
      ),
    ).toBe(1);
    expect(
      dragScrollDirection(
        { isDragging: true, anchor: { row: 1 }, focus: { row: 9 } } as never,
        2,
        8,
      ),
    ).toBe(0);
    expect(
      dragScrollDirection(
        { isDragging: true, anchor: { row: 5 }, focus: { row: 9 } } as never,
        2,
        8,
        1,
      ),
    ).toBe(1);
    expect(
      dragScrollDirection(
        { isDragging: true, anchor: { row: 5 }, focus: { row: 1 } } as never,
        2,
        8,
        1,
      ),
    ).toBe(0);
  });

  test("jumps with pending delta, clamps top, and reports sticky bottom", () => {
    const mid = makeScrollBox({ pendingDelta: 5, scrollTop: 10 });
    expect(jumpBy(mid.handle as never, 10)).toBe(false);
    expect(mid.calls).toEqual([["scrollTo", 25]]);

    const top = makeScrollBox({ pendingDelta: -20, scrollTop: 10 });
    expect(jumpBy(top.handle as never, -10)).toBe(false);
    expect(top.calls).toEqual([["scrollTo", 0]]);

    const bottom = makeScrollBox({ pendingDelta: 4, scrollTop: 70 });
    expect(jumpBy(bottom.handle as never, 10)).toBe(true);
    expect(bottom.calls).toEqual([["scrollTo", 80], ["scrollToBottom"]]);
  });

  test("scrollUp clears pending negative overscroll or scrolls by a negative amount", () => {
    const top = makeScrollBox({ pendingDelta: -3, scrollTop: 2 });
    scrollUp(top.handle as never, 1);
    expect(top.calls).toEqual([["scrollTo", 0]]);

    const mid = makeScrollBox({ pendingDelta: 2, scrollTop: 20 });
    scrollUp(mid.handle as never, 5);
    expect(mid.calls).toEqual([["scrollBy", -5]]);
  });
});

describe("ScrollKeybindingHandler modal pager", () => {
  test.each<Array<[string, Record<string, boolean>, ModalPagerAction | null]>>([
    ["", { upArrow: true }, "lineUp"],
    ["", { downArrow: true }, "lineDown"],
    ["", { home: true }, "top"],
    ["", { end: true }, "bottom"],
    ["u", { ctrl: true }, "halfPageUp"],
    ["d", { ctrl: true }, "halfPageDown"],
    ["b", { ctrl: true }, "fullPageUp"],
    ["f", { ctrl: true }, "fullPageDown"],
    ["n", { ctrl: true }, "lineDown"],
    ["p", { ctrl: true }, "lineUp"],
    ["g", {}, "top"],
    ["ggg", {}, "top"],
    ["G", {}, "bottom"],
    ["g", { shift: true }, "bottom"],
    ["j", {}, "lineDown"],
    ["k", {}, "lineUp"],
    [" ", {}, "fullPageDown"],
    ["b", {}, "fullPageUp"],
    ["gG", {}, null],
    ["x", { meta: true }, null],
    ["u", { ctrl: true, shift: true }, null],
    ["k", { shift: true }, null],
  ])("maps %j plus %j to %j", (input, key, expected) => {
    expect(modalPagerAction(input, key as never)).toBe(expected);
  });

  test("applies modal pager actions and reports sticky state", () => {
    const beforeJump = vi.fn();
    const line = makeScrollBox({ scrollTop: 20 });
    expect(applyModalPagerAction(line.handle as never, "lineDown", beforeJump)).toBe(
      false,
    );
    expect(beforeJump).toHaveBeenCalledWith(1);
    expect(line.calls).toEqual([["scrollTo", 21]]);

    const half = makeScrollBox({ scrollTop: 20, viewportHeight: 9 });
    expect(applyModalPagerAction(half.handle as never, "halfPageUp", beforeJump)).toBe(
      false,
    );
    expect(beforeJump).toHaveBeenCalledWith(-4);

    const page = makeScrollBox({ scrollTop: 20, viewportHeight: 9 });
    expect(applyModalPagerAction(page.handle as never, "fullPageDown", beforeJump)).toBe(
      false,
    );
    expect(beforeJump).toHaveBeenCalledWith(9);

    const top = makeScrollBox({ pendingDelta: 3, scrollTop: 20 });
    expect(applyModalPagerAction(top.handle as never, "top", beforeJump)).toBe(false);
    expect(beforeJump).toHaveBeenCalledWith(-23);
    expect(top.calls).toEqual([["scrollTo", 0]]);

    const bottom = makeScrollBox({ pendingDelta: 3, scrollTop: 20 });
    expect(applyModalPagerAction(bottom.handle as never, "bottom", beforeJump)).toBe(
      true,
    );
    expect(beforeJump).toHaveBeenCalledWith(57);
    expect(bottom.calls).toEqual([["scrollTo", 80], ["scrollToBottom"]]);

    expect(applyModalPagerAction(bottom.handle as never, null, beforeJump)).toBeNull();
  });
});
