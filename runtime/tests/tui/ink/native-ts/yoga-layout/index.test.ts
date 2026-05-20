import { describe, expect, test } from "vitest";

import YogaDefault, {
  Align,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Node,
  Overflow,
  PositionType,
  Unit,
  Wrap,
  getYogaCounters,
  loadYoga,
} from "./index.js";

describe("yoga-layout TypeScript shim", () => {
  test("exports the load API, node factories, and mutable config object", async () => {
    const Yoga = await loadYoga();
    expect(Yoga).toBe(YogaDefault);

    const config = Yoga.Config.create();
    config.setPointScaleFactor(2);
    config.setErrata(Errata.Classic);
    config.setUseWebDefaults(true);
    config.setExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis, true);

    expect(config.pointScaleFactor).toBe(2);
    expect(config.getErrata()).toBe(Errata.Classic);
    expect(config.useWebDefaults).toBe(true);
    expect(config.isExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis)).toBe(
      false,
    );

    const beforeLive = getYogaCounters().live;
    const defaultNode = Yoga.Node.createDefault();
    const createdNode = Yoga.Node.create();
    const configuredNode = Yoga.Node.createWithConfig(config);

    try {
      expect(defaultNode).toBeInstanceOf(Node);
      expect(createdNode).toBeInstanceOf(Node);
      expect(configuredNode.config).toBe(config);
      expect(() => Yoga.Node.destroy(createdNode)).not.toThrow();
    } finally {
      defaultNode.free();
      createdNode.free();
      configuredNode.free();
      Yoga.Config.destroy(config);
      config.free();
    }

    expect(getYogaCounters().live).toBe(beforeLive);
  });

  test("normalizes dimension setters and flex shorthand through public getters", () => {
    const node = YogaDefault.Node.createDefault();

    try {
      node.setWidthPercent(50);
      node.setHeight("25%");
      node.setMinWidth(Number.POSITIVE_INFINITY);
      node.setMaxHeight("bad-value");
      node.setFlex(2);

      expect(node.getWidth()).toEqual({ unit: Unit.Percent, value: 50 });
      expect(node.getHeight()).toEqual({ unit: Unit.Percent, value: 25 });
      expect(node.style.minWidth.unit).toBe(Unit.Undefined);
      expect(node.style.maxHeight.unit).toBe(Unit.Undefined);
      expect(node.getFlexGrow()).toBe(2);
      expect(node.getFlexShrink()).toBe(1);
      expect(node.getFlexBasis()).toEqual({ unit: Unit.Point, value: 0 });

      node.setFlex(-3);
      expect(node.getFlexGrow()).toBe(0);
      expect(node.getFlexShrink()).toBe(3);

      node.setFlex(Number.NaN);
      expect(node.getFlexGrow()).toBe(0);
      expect(node.getFlexShrink()).toBe(0);

      node.setFlexBasisAuto();
      expect(node.getFlexBasis().unit).toBe(Unit.Auto);
      node.setFlexBasisPercent(30);
      expect(node.getFlexBasis()).toEqual({ unit: Unit.Percent, value: 30 });
    } finally {
      node.free();
    }
  });

  test("resolves physical edge fallbacks and percentages for computed spacing", () => {
    const root = YogaDefault.Node.createDefault();
    const child = YogaDefault.Node.createDefault();

    try {
      root.setWidth(200);
      root.setHeight(100);
      root.setPadding(Edge.All, 2);
      root.setPaddingPercent(Edge.Horizontal, 10);
      root.setBorder(Edge.Vertical, 3);
      root.setBorder(Edge.Left, 4);

      child.setWidth(20);
      child.setHeight(10);
      child.setMargin(Edge.All, 1);
      child.setMargin(Edge.Horizontal, "10%");
      child.setMargin(Edge.Start, 7);
      child.setMargin(Edge.End, 9);
      child.setMargin(Edge.Left, 3);

      root.insertChild(child, 0);
      root.calculateLayout(200, 100);

      expect(root.getComputedPadding(Edge.Left)).toBe(20);
      expect(root.getComputedPadding(Edge.End)).toBe(20);
      expect(root.getComputedPadding(Edge.Top)).toBe(2);
      expect(root.getComputedBorder(Edge.Left)).toBe(4);
      expect(root.getComputedBorder(Edge.Bottom)).toBe(3);
      expect(child.getComputedMargin(Edge.Left)).toBe(3);
      expect(child.getComputedMargin(Edge.End)).toBe(20);
      expect(child.getComputedMargin(99 as Edge)).toBe(3);
    } finally {
      root.freeRecursive();
    }
  });

  test("measures leaf nodes, reports counters, and cache-hits unchanged layouts", () => {
    const root = YogaDefault.Node.createDefault();
    const measured = YogaDefault.Node.createDefault();
    const calls: Array<{
      width: number;
      widthMode: MeasureMode;
      heightMode: MeasureMode;
    }> = [];

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setWidth(10);
      root.setHeight(4);
      measured.setMeasureFunc((width, widthMode, _height, heightMode) => {
        calls.push({ width, widthMode, heightMode });
        return { width: Math.min(width, 6), height: 1 };
      });
      root.insertChild(measured, 0);

      root.calculateLayout(undefined, undefined);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            width: 10,
            widthMode: MeasureMode.AtMost,
            heightMode: MeasureMode.Exactly,
          }),
        ]),
      );
      expect(measured.getComputedWidth()).toBe(6);
      expect(measured.getComputedHeight()).toBe(4);
      expect(getYogaCounters().measured).toBeGreaterThan(0);

      root.calculateLayout(undefined, undefined);
      expect(getYogaCounters().cacheHits).toBeGreaterThan(0);
    } finally {
      root.freeRecursive();
    }
  });

  test("zeros display:none subtrees and lays out display:contents children directly", () => {
    const root = YogaDefault.Node.createDefault();
    const hidden = YogaDefault.Node.createDefault();
    const hiddenChild = YogaDefault.Node.createDefault();
    const contents = YogaDefault.Node.createDefault();
    const lifted = YogaDefault.Node.createDefault();

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setWidth(30);
      root.setHeight(8);

      hidden.setDisplay(Display.None);
      hidden.setWidth(5);
      hidden.setHeight(4);
      hiddenChild.setWidth(2);
      hiddenChild.setHeight(2);
      hidden.insertChild(hiddenChild, 0);

      contents.setDisplay(Display.Contents);
      contents.setWidth(20);
      contents.setHeight(20);
      lifted.setWidth(7);
      lifted.setHeight(3);
      contents.insertChild(lifted, 0);

      root.insertChild(hidden, 0);
      root.insertChild(contents, 1);
      root.calculateLayout(undefined, undefined);

      expect(hidden.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      });
      expect(hiddenChild.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      });
      expect(contents.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      });
      expect(lifted.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 7,
        height: 3,
      });

      hidden.setDisplay(Display.Flex);
      root.calculateLayout(undefined, undefined);

      expect(hidden.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 5,
        height: 4,
      });
      expect(hiddenChild.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 2,
        height: 2,
      });
      expect(lifted.getComputedLeft()).toBe(5);
    } finally {
      root.freeRecursive();
    }
  });

  test("positions flow children with auto margins, relative offsets, and gap", () => {
    const config = YogaDefault.Config.create();
    config.setPointScaleFactor(0);
    const root = YogaDefault.Node.createWithConfig(config);
    const child = YogaDefault.Node.createWithConfig(config);

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setWidth(30);
      root.setHeight(10);
      root.setGap(Gutter.Column, 2);

      child.setWidth(6);
      child.setHeight(2);
      child.setMarginAuto(Edge.Left);
      child.setMarginAuto(Edge.Right);
      child.setMarginAuto(Edge.Top);
      child.setMarginAuto(Edge.Bottom);
      child.setPosition(Edge.Top, 1);
      child.setPositionPercent(Edge.Left, 10);

      root.insertChild(child, 0);
      root.calculateLayout(undefined, undefined);

      expect(child.getComputedLayout()).toMatchObject({
        left: 15,
        top: 5,
        width: 6,
        height: 2,
      });
    } finally {
      root.freeRecursive();
      config.free();
    }
  });

  test("derives absolute child sizes from opposing insets and padding box", () => {
    const root = YogaDefault.Node.createDefault();
    const child = YogaDefault.Node.createDefault();

    try {
      root.setWidth(100);
      root.setHeight(40);
      root.setPadding(Edge.All, 5);
      root.setBorder(Edge.All, 1);

      child.setPositionType(PositionType.Absolute);
      child.setPositionPercent(Edge.Left, 10);
      child.setPosition(Edge.Right, 20);
      child.setPosition(Edge.Bottom, 4);
      child.setHeight(6);

      root.insertChild(child, 0);
      root.calculateLayout(undefined, undefined);

      expect(child.getComputedLayout()).toMatchObject({
        left: 11,
        top: 29,
        width: 68,
        height: 6,
      });
      expect(root.getComputedRight()).toBe(0);
      expect(root.getComputedBottom()).toBe(0);
    } finally {
      root.freeRecursive();
    }
  });

  test("wraps lines, distributes align-content space, and flips wrap-reverse", () => {
    const root = YogaDefault.Node.createDefault();
    const first = YogaDefault.Node.createDefault();
    const second = YogaDefault.Node.createDefault();
    const third = YogaDefault.Node.createDefault();

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setFlexWrap(Wrap.WrapReverse);
      root.setAlignContent(Align.SpaceBetween);
      root.setJustifyContent(Justify.FlexStart);
      root.setOverflow(Overflow.Visible);
      root.setWidth(10);
      root.setHeight(20);

      for (const child of [first, second, third]) {
        child.setWidth(6);
        child.setHeight(2);
        root.insertChild(child, root.getChildCount());
      }

      root.calculateLayout(undefined, undefined);

      expect(first.getComputedTop()).toBe(18);
      expect(second.getComputedTop()).toBe(9);
      expect(third.getComputedTop()).toBe(0);
      expect(root.getFlexWrap()).toBe(Wrap.WrapReverse);
      expect(root.getAlignContent()).toBe(Align.SpaceBetween);
      expect(root.getJustifyContent()).toBe(Justify.FlexStart);
      expect(root.getOverflow()).toBe(Overflow.Visible);
    } finally {
      root.freeRecursive();
    }
  });
});
