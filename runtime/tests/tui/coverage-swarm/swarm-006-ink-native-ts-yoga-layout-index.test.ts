import { describe, expect, test } from "vitest";

import YogaDefault, {
  Align,
  BoxSizing,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  PositionType,
  Unit,
  Wrap,
} from "../../../src/tui/ink/native-ts/yoga-layout/index.js";

function unscaledConfig() {
  const config = YogaDefault.Config.create();
  config.setPointScaleFactor(0);
  return config;
}

function expectClose(value: number, expected: number) {
  expect(value).toBeCloseTo(expected, 5);
}

describe("coverage swarm row 006 yoga-layout shim", () => {
  test("covers tree, lifecycle, dirty, and parity stub helpers", () => {
    const root = YogaDefault.Node.createDefault();
    const child = YogaDefault.Node.createDefault();
    const stray = YogaDefault.Node.createDefault();

    try {
      root.removeChild(stray);
      expect(root.getChildCount()).toBe(0);

      root.setWidth(10);
      root.setHeight(10);
      child.setWidth(2);
      root.insertChild(child, 0);

      expect(root.getChild(0)).toBe(child);
      expect(child.getParent()).toBe(root);

      root.calculateLayout(undefined, undefined);
      expect(root.isDirty()).toBe(false);

      child.setHeight(3);
      expect(child.isDirty()).toBe(true);
      expect(root.isDirty()).toBe(true);
      expect(child.hasNewLayout()).toBe(true);
      child.markLayoutSeen();

      root.removeChild(child);
      expect(child.getParent()).toBeNull();

      child.setMeasureFunc(() => ({ width: 1, height: 1 }));
      child.unsetMeasureFunc();
      expect(child.measureFunc).toBeNull();

      child.copyStyle(root);
      child.setDirtiedFunc(() => {});
      child.unsetDirtiedFunc();
      child.setAspectRatio(1);
      child.setAlwaysFormsContainingBlock(true);
      child.setBoxSizing(BoxSizing.ContentBox);
      expect(Number.isNaN(child.getAspectRatio())).toBe(true);

      child.reset();
      expect(child.getChildCount()).toBe(0);
      expect(child.getParent()).toBeNull();
      expect(child.isDirty()).toBe(true);
      expect(child.getWidth()).toMatchObject({ unit: Unit.Auto });
    } finally {
      root.free();
      child.free();
      stray.free();
    }
  });

  test("normalizes additional style setters and getters", () => {
    const node = YogaDefault.Node.createDefault();

    try {
      node.setWidth(undefined);
      expect(node.getWidth().unit).toBe(Unit.Undefined);

      node.setHeightAuto();
      expect(node.getHeight().unit).toBe(Unit.Auto);
      node.setHeightPercent(40);
      expect(node.getHeight()).toEqual({ unit: Unit.Percent, value: 40 });

      node.setMinWidthPercent(25);
      node.setMinHeightPercent(30);
      node.setMaxWidth("80");
      expect(node.style.maxWidth).toEqual({ unit: Unit.Point, value: 80 });
      node.setMaxWidthPercent(75);
      node.setMaxHeightPercent(50);
      expect(node.style.minWidth).toEqual({ unit: Unit.Percent, value: 25 });
      expect(node.style.minHeight).toEqual({ unit: Unit.Percent, value: 30 });
      expect(node.style.maxWidth).toEqual({ unit: Unit.Percent, value: 75 });
      expect(node.style.maxHeight).toEqual({ unit: Unit.Percent, value: 50 });

      node.setFlexGrow(undefined);
      node.setFlexShrink(undefined);
      node.setFlex(0);
      expect(node.getFlexGrow()).toBe(0);
      expect(node.getFlexShrink()).toBe(0);

      node.setFlexBasis("auto");
      expect(node.getFlexBasis().unit).toBe(Unit.Auto);
      node.setFlexBasis("12");
      expect(node.getFlexBasis()).toEqual({ unit: Unit.Point, value: 12 });

      node.setFlexDirection(FlexDirection.RowReverse);
      node.setPositionType(PositionType.Static);
      node.setPositionAuto(Edge.Right);
      node.setDirection(Direction.RTL);
      expect(node.getFlexDirection()).toBe(FlexDirection.RowReverse);
      expect(node.getPositionType()).toBe(PositionType.Static);
      expect(node.getDirection()).toBe(Direction.RTL);
      expect(node.style.position[Edge.Right]).toMatchObject({
        unit: Unit.Auto,
      });

      node.setMargin(Edge.Right, "auto");
      node.setMargin(Edge.Right, undefined);
      node.setMarginPercent(Edge.Left, 25);
      node.setGapPercent(Gutter.Row, 10);
      expect(node.style.margin[Edge.Left]).toEqual({
        unit: Unit.Percent,
        value: 25,
      });
      expect(node.style.gap[Gutter.Row]).toEqual({
        unit: Unit.Percent,
        value: 10,
      });
    } finally {
      node.free();
    }
  });

  test("lays out reversed axes and percent min/max bounds", () => {
    const config = unscaledConfig();
    const rowReverse = YogaDefault.Node.createWithConfig(config);
    const first = YogaDefault.Node.createWithConfig(config);
    const second = YogaDefault.Node.createWithConfig(config);
    const columnReverse = YogaDefault.Node.createWithConfig(config);
    const top = YogaDefault.Node.createWithConfig(config);
    const bottom = YogaDefault.Node.createWithConfig(config);
    const bounded = YogaDefault.Node.createWithConfig(config);
    const maxed = YogaDefault.Node.createWithConfig(config);
    const mined = YogaDefault.Node.createWithConfig(config);

    try {
      rowReverse.setFlexDirection(FlexDirection.RowReverse);
      rowReverse.setWidth(20);
      rowReverse.setHeight(5);
      first.setWidth(3);
      first.setHeight(1);
      second.setWidth(4);
      second.setHeight(1);
      rowReverse.insertChild(first, 0);
      rowReverse.insertChild(second, 1);
      rowReverse.calculateLayout(undefined, undefined);

      expect(first.getComputedLeft()).toBe(17);
      expect(second.getComputedLeft()).toBe(13);

      columnReverse.setFlexDirection(FlexDirection.ColumnReverse);
      columnReverse.setWidth(5);
      columnReverse.setHeight(10);
      top.setWidth(1);
      top.setHeight(2);
      bottom.setWidth(1);
      bottom.setHeight(3);
      columnReverse.insertChild(top, 0);
      columnReverse.insertChild(bottom, 1);
      columnReverse.calculateLayout(undefined, undefined);

      expect(top.getComputedTop()).toBe(8);
      expect(bottom.getComputedTop()).toBe(5);

      bounded.setFlexDirection(FlexDirection.Row);
      bounded.setWidth(100);
      bounded.setHeight(5);
      maxed.setWidth(80);
      maxed.setMaxWidthPercent(50);
      mined.setWidth(10);
      mined.setMinWidthPercent(30);
      bounded.insertChild(maxed, 0);
      bounded.insertChild(mined, 1);
      bounded.calculateLayout(undefined, undefined);

      expect(maxed.getComputedWidth()).toBe(50);
      expect(mined.getComputedWidth()).toBe(30);
    } finally {
      rowReverse.freeRecursive();
      columnReverse.freeRecursive();
      bounded.freeRecursive();
      config.free();
    }
  });

  test("distributes wrapped lines for align-content variants", () => {
    const cases: Array<[Align, number[]]> = [
      [Align.Center, [7, 9, 11]],
      [Align.FlexEnd, [14, 16, 18]],
      [Align.Stretch, [0, 20 / 3, 40 / 3]],
      [Align.SpaceAround, [7 / 3, 9, 47 / 3]],
      [Align.SpaceEvenly, [3.5, 9, 14.5]],
      [Align.Baseline, [0, 2, 4]],
    ];

    for (const [alignContent, expectedTops] of cases) {
      const config = unscaledConfig();
      const root = YogaDefault.Node.createWithConfig(config);
      const children = [
        YogaDefault.Node.createWithConfig(config),
        YogaDefault.Node.createWithConfig(config),
        YogaDefault.Node.createWithConfig(config),
      ];

      try {
        root.setFlexDirection(FlexDirection.Row);
        root.setFlexWrap(Wrap.Wrap);
        root.setAlignItems(Align.FlexStart);
        root.setAlignContent(alignContent);
        root.setWidth(10);
        root.setHeight(20);

        for (const child of children) {
          child.setWidth(6);
          child.setHeight(2);
          root.insertChild(child, root.getChildCount());
        }

        root.calculateLayout(undefined, undefined);

        children.forEach((child, index) => {
          expectClose(child.getComputedTop(), expectedTops[index]!);
          expect(child.getComputedHeight()).toBe(2);
        });
      } finally {
        root.freeRecursive();
        config.free();
      }
    }
  });

  test("positions flow children with space-around, space-evenly, and one-sided auto margins", () => {
    const config = unscaledConfig();
    const around = YogaDefault.Node.createWithConfig(config);
    const aroundA = YogaDefault.Node.createWithConfig(config);
    const aroundB = YogaDefault.Node.createWithConfig(config);
    const evenly = YogaDefault.Node.createWithConfig(config);
    const evenlyA = YogaDefault.Node.createWithConfig(config);
    const evenlyB = YogaDefault.Node.createWithConfig(config);
    const empty = YogaDefault.Node.createWithConfig(config);
    const autoRoot = YogaDefault.Node.createWithConfig(config);
    const autoLead = YogaDefault.Node.createWithConfig(config);
    const autoTrail = YogaDefault.Node.createWithConfig(config);
    const relative = YogaDefault.Node.createWithConfig(config);

    try {
      for (const root of [around, evenly]) {
        root.setFlexDirection(FlexDirection.Row);
        root.setAlignItems(Align.FlexStart);
        root.setWidth(20);
        root.setHeight(4);
      }

      for (const child of [aroundA, aroundB, evenlyA, evenlyB]) {
        child.setWidth(2);
        child.setHeight(1);
      }

      around.setJustifyContent(Justify.SpaceAround);
      around.insertChild(aroundA, 0);
      around.insertChild(aroundB, 1);
      around.calculateLayout(undefined, undefined);
      expectClose(aroundA.getComputedLeft(), 4);
      expectClose(aroundB.getComputedLeft(), 14);

      evenly.setJustifyContent(Justify.SpaceEvenly);
      evenly.insertChild(evenlyA, 0);
      evenly.insertChild(evenlyB, 1);
      evenly.calculateLayout(undefined, undefined);
      expectClose(evenlyA.getComputedLeft(), 16 / 3);
      expectClose(evenlyB.getComputedLeft(), 38 / 3);

      empty.setFlexDirection(FlexDirection.Row);
      empty.setJustifyContent(Justify.SpaceAround);
      empty.setWidth(10);
      empty.setHeight(2);
      empty.calculateLayout(undefined, undefined);
      expect(empty.getChildCount()).toBe(0);

      autoRoot.setFlexDirection(FlexDirection.Row);
      autoRoot.setAlignItems(Align.FlexStart);
      autoRoot.setWidth(30);
      autoRoot.setHeight(10);
      autoLead.setWidth(2);
      autoLead.setHeight(2);
      autoLead.setMarginAuto(Edge.Top);
      autoTrail.setWidth(2);
      autoTrail.setHeight(2);
      autoTrail.setMarginAuto(Edge.Bottom);
      relative.setWidth(2);
      relative.setHeight(2);
      relative.setPosition(Edge.Right, 1);
      relative.setPosition(Edge.Bottom, 2);
      autoRoot.insertChild(autoLead, 0);
      autoRoot.insertChild(autoTrail, 1);
      autoRoot.insertChild(relative, 2);
      autoRoot.calculateLayout(undefined, undefined);

      expect(autoLead.getComputedTop()).toBe(8);
      expect(autoTrail.getComputedTop()).toBe(0);
      expect(relative.getComputedLeft()).toBe(3);
      expect(relative.getComputedTop()).toBe(-2);
    } finally {
      around.freeRecursive();
      evenly.freeRecursive();
      empty.freeRecursive();
      autoRoot.freeRecursive();
      config.free();
    }
  });

  test("covers absolute child derived sizes and fallback alignment", () => {
    const config = unscaledConfig();
    const derived = YogaDefault.Node.createWithConfig(config);
    const derivedChild = YogaDefault.Node.createWithConfig(config);
    const wrapReverse = YogaDefault.Node.createWithConfig(config);
    const wrapReverseChild = YogaDefault.Node.createWithConfig(config);
    const columnReverse = YogaDefault.Node.createWithConfig(config);
    const columnReverseChild = YogaDefault.Node.createWithConfig(config);

    try {
      derived.setWidth(50);
      derived.setHeight(30);
      derivedChild.setPositionType(PositionType.Absolute);
      derivedChild.setPosition(Edge.Left, 5);
      derivedChild.setPosition(Edge.Top, 3);
      derivedChild.setPosition(Edge.Bottom, 5);
      derivedChild.setWidth(10);
      derived.insertChild(derivedChild, 0);
      derived.calculateLayout(undefined, undefined);

      expect(derivedChild.getComputedLayout()).toMatchObject({
        left: 5,
        top: 3,
        width: 10,
        height: 22,
      });

      wrapReverse.setFlexDirection(FlexDirection.Column);
      wrapReverse.setFlexWrap(Wrap.WrapReverse);
      wrapReverse.setWidth(20);
      wrapReverse.setHeight(20);
      wrapReverseChild.setPositionType(PositionType.Absolute);
      wrapReverseChild.setWidth(4);
      wrapReverseChild.setHeight(5);
      wrapReverse.insertChild(wrapReverseChild, 0);
      wrapReverse.calculateLayout(undefined, undefined);

      expect(wrapReverseChild.getComputedLayout()).toMatchObject({
        left: 16,
        top: 0,
        width: 4,
        height: 5,
      });

      columnReverse.setFlexDirection(FlexDirection.ColumnReverse);
      columnReverse.setAlignItems(Align.FlexStart);
      columnReverse.setWidth(20);
      columnReverse.setHeight(20);
      columnReverseChild.setPositionType(PositionType.Absolute);
      columnReverseChild.setWidth(4);
      columnReverseChild.setHeight(5);
      columnReverse.insertChild(columnReverseChild, 0);
      columnReverse.calculateLayout(undefined, undefined);

      expect(columnReverseChild.getComputedLayout()).toMatchObject({
        left: 0,
        top: 15,
        width: 4,
        height: 5,
      });
    } finally {
      derived.freeRecursive();
      wrapReverse.freeRecursive();
      columnReverse.freeRecursive();
      config.free();
    }
  });

  test("exercises explicit flex-basis and partial flex grow and shrink distribution", () => {
    const config = unscaledConfig();
    const basisRoot = YogaDefault.Node.createWithConfig(config);
    const basisChild = YogaDefault.Node.createWithConfig(config);
    const growRoot = YogaDefault.Node.createWithConfig(config);
    const growA = YogaDefault.Node.createWithConfig(config);
    const growB = YogaDefault.Node.createWithConfig(config);
    const shrinkRoot = YogaDefault.Node.createWithConfig(config);
    const shrinkA = YogaDefault.Node.createWithConfig(config);
    const shrinkB = YogaDefault.Node.createWithConfig(config);

    try {
      basisRoot.setFlexDirection(FlexDirection.Row);
      basisRoot.setWidth(20);
      basisRoot.setHeight(4);
      basisChild.setFlexBasis("25%");
      basisRoot.insertChild(basisChild, 0);
      basisRoot.calculateLayout(undefined, undefined);
      expect(basisChild.getComputedWidth()).toBe(5);

      growRoot.setFlexDirection(FlexDirection.Row);
      growRoot.setWidth(100);
      growRoot.setHeight(4);
      for (const child of [growA, growB]) {
        child.setWidth(10);
        child.setHeight(1);
        child.setFlexGrow(0.25);
        growRoot.insertChild(child, growRoot.getChildCount());
      }
      growRoot.calculateLayout(undefined, undefined);
      expectClose(growA.getComputedWidth(), 30);
      expectClose(growB.getComputedWidth(), 30);

      shrinkRoot.setFlexDirection(FlexDirection.Row);
      shrinkRoot.setWidth(10);
      shrinkRoot.setHeight(4);
      for (const child of [shrinkA, shrinkB]) {
        child.setWidth(10);
        child.setHeight(1);
        child.setFlexShrink(0.25);
        shrinkRoot.insertChild(child, shrinkRoot.getChildCount());
      }
      shrinkRoot.calculateLayout(undefined, undefined);
      expectClose(shrinkA.getComputedWidth(), 7.5);
      expectClose(shrinkB.getComputedWidth(), 7.5);
    } finally {
      basisRoot.freeRecursive();
      growRoot.freeRecursive();
      shrinkRoot.freeRecursive();
      config.free();
    }
  });

  test("applies root position offsets and percent gap fallback", () => {
    const config = unscaledConfig();
    const root = YogaDefault.Node.createWithConfig(config);
    const first = YogaDefault.Node.createWithConfig(config);
    const second = YogaDefault.Node.createWithConfig(config);

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setWidth(40);
      root.setHeight(4);
      root.setPositionPercent(Edge.Left, 10);
      root.setPosition(Edge.Top, "2");
      root.setGap(Gutter.All, "10%");
      first.setWidth(2);
      first.setHeight(1);
      second.setWidth(2);
      second.setHeight(1);
      root.insertChild(first, 0);
      root.insertChild(second, 1);
      root.calculateLayout(40, 4);

      expect(root.getComputedLeft()).toBe(4);
      expect(root.getComputedTop()).toBe(2);
      expect(second.getComputedLeft()).toBe(6);
    } finally {
      root.freeRecursive();
      config.free();
    }
  });
});
