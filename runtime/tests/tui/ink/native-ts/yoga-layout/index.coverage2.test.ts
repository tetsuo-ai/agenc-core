import { describe, expect, test } from "vitest";

import YogaDefault, { Align, Edge, FlexDirection } from "./index.js";

describe("yoga-layout TypeScript shim baseline coverage", () => {
  test("aligns row children to a nested reference baseline", () => {
    const config = YogaDefault.Config.create();
    config.setPointScaleFactor(0);

    const root = YogaDefault.Node.createWithConfig(config);
    const tall = YogaDefault.Node.createWithConfig(config);
    const container = YogaDefault.Node.createWithConfig(config);
    const label = YogaDefault.Node.createWithConfig(config);
    const flexStart = YogaDefault.Node.createWithConfig(config);

    try {
      root.setFlexDirection(FlexDirection.Row);
      root.setAlignItems(Align.Baseline);
      root.setWidth(20);
      root.setHeight(20);

      tall.setWidth(4);
      tall.setHeight(7);

      container.setWidth(6);
      container.setHeight(8);

      label.setWidth(6);
      label.setHeight(3);
      label.setMargin(Edge.Top, 2);
      label.setIsReferenceBaseline(true);
      container.insertChild(label, 0);

      flexStart.setWidth(2);
      flexStart.setHeight(1);
      flexStart.setAlignSelf(Align.FlexStart);

      root.insertChild(tall, 0);
      root.insertChild(container, 1);
      root.insertChild(flexStart, 2);

      root.calculateLayout(undefined, undefined);

      expect(root.getAlignItems()).toBe(Align.Baseline);
      expect(label.isReferenceBaseline()).toBe(true);
      expect(flexStart.getAlignSelf()).toBe(Align.FlexStart);
      expect(tall.getComputedLayout()).toMatchObject({
        left: 0,
        top: 0,
        width: 4,
        height: 7,
      });
      expect(container.getComputedLayout()).toMatchObject({
        left: 4,
        top: 2,
        width: 6,
        height: 8,
      });
      expect(label.getComputedLayout()).toMatchObject({
        left: 0,
        top: 2,
        width: 6,
        height: 3,
      });
      expect(flexStart.getComputedLayout()).toMatchObject({
        left: 10,
        top: 0,
        width: 2,
        height: 1,
      });
    } finally {
      root.freeRecursive();
      config.free();
    }
  });
});
