import { describe, expect, test } from "vitest";
import Yoga, { Edge, FlexDirection } from "../../../../../src/tui/ink/native-ts/yoga-layout/index.js";

describe("content-box and descendant layout authority", () => {
  test("resolves flow-child percentage dimensions inside padding and borders", () => {
    const root = Yoga.Node.create();
    const child = Yoga.Node.create();
    root.setWidth(96);
    root.setHeight(40);
    root.setPadding(Edge.Horizontal, 3);
    root.setPadding(Edge.Vertical, 2);
    root.setBorder(Edge.All, 1);
    child.setWidthPercent(100);
    child.setHeightPercent(50);
    root.insertChild(child, 0);
    try {
      root.calculateLayout(96, 40);
      expect(child.getComputedWidth()).toBe(88);
      expect(child.getComputedHeight()).toBe(17);
      expect(child.getComputedLeft()).toBe(4);
      expect(child.getComputedTop()).toBe(3);
    } finally {
      root.freeRecursive();
    }
  });

  test("restores complete descendant geometry after intrinsic measure and persistent resizing", () => {
    const root = Yoga.Node.create();
    const row = Yoga.Node.create();
    const label = Yoga.Node.create();
    const column = Yoga.Node.create();
    const content = Yoga.Node.create();
    const text = Yoga.Node.create();
    root.setFlexDirection(FlexDirection.Column);
    root.setHeight(48);
    row.setFlexDirection(FlexDirection.Row);
    row.setWidthPercent(100);
    label.setWidth(7);
    label.setFlexShrink(0);
    column.setFlexGrow(1);
    column.setFlexShrink(1);
    column.setMinWidth(0);
    column.setFlexDirection(FlexDirection.Column);
    content.setFlexDirection(FlexDirection.Column);
    text.setMeasureFunc((width) => ({ width, height: Math.ceil(200 / width) }));
    root.insertChild(row, 0);
    row.insertChild(label, 0);
    row.insertChild(column, 1);
    column.insertChild(content, 0);
    content.insertChild(text, 0);
    try {
      for (const width of [90, 114, 90]) {
        root.setWidth(width);
        root.calculateLayout(width, 48);
        expect(column.getComputedWidth()).toBe(width - 7);
        expect(content.getComputedWidth()).toBe(width - 7);
        expect(text.getComputedWidth()).toBe(width - 7);
        expect(text.getComputedHeight()).toBe(Math.ceil(200 / (width - 7)));
      }
    } finally {
      root.freeRecursive();
    }
  });
});
