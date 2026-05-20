import { describe, expect, test } from "vitest";

import YogaDefault, {
  Align,
  FlexDirection,
  Justify,
  PositionType,
  Wrap,
} from "./index.js";

describe("yoga-layout absolute fallback placement", () => {
  test("positions inset-free absolute children from parent flex alignment", () => {
    const config = YogaDefault.Config.create();
    config.setPointScaleFactor(0);

    const createRoot = () => {
      const root = YogaDefault.Node.createWithConfig(config);
      root.setWidth(100);
      root.setHeight(40);
      return root;
    };

    const createAbsoluteChild = () => {
      const child = YogaDefault.Node.createWithConfig(config);
      child.setPositionType(PositionType.Absolute);
      child.setWidth(10);
      child.setHeight(6);
      return child;
    };

    const rowFlexEnd = createRoot();
    const rowFlexEndChild = createAbsoluteChild();
    rowFlexEnd.setFlexDirection(FlexDirection.Row);
    rowFlexEnd.setJustifyContent(Justify.FlexEnd);
    rowFlexEnd.setAlignItems(Align.Center);
    rowFlexEnd.insertChild(rowFlexEndChild, 0);

    const rowWrapReverse = createRoot();
    const rowWrapReverseChild = createAbsoluteChild();
    rowWrapReverse.setFlexDirection(FlexDirection.Row);
    rowWrapReverse.setJustifyContent(Justify.Center);
    rowWrapReverse.setAlignItems(Align.FlexEnd);
    rowWrapReverse.setFlexWrap(Wrap.WrapReverse);
    rowWrapReverse.insertChild(rowWrapReverseChild, 0);

    const columnCenter = createRoot();
    const columnCenterChild = createAbsoluteChild();
    columnCenter.setFlexDirection(FlexDirection.Column);
    columnCenter.setJustifyContent(Justify.Center);
    columnCenter.setAlignItems(Align.FlexEnd);
    columnCenter.insertChild(columnCenterChild, 0);

    try {
      rowFlexEnd.calculateLayout(undefined, undefined);
      rowWrapReverse.calculateLayout(undefined, undefined);
      columnCenter.calculateLayout(undefined, undefined);

      expect(rowFlexEndChild.getComputedLayout()).toMatchObject({
        left: 90,
        top: 17,
        width: 10,
        height: 6,
      });
      expect(rowWrapReverseChild.getComputedLayout()).toMatchObject({
        left: 45,
        top: 0,
        width: 10,
        height: 6,
      });
      expect(columnCenterChild.getComputedLayout()).toMatchObject({
        left: 90,
        top: 17,
        width: 10,
        height: 6,
      });
    } finally {
      rowFlexEnd.freeRecursive();
      rowWrapReverse.freeRecursive();
      columnCenter.freeRecursive();
      config.free();
    }
  });
});
