import { describe, expect, test, vi } from 'vitest'

import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  LayoutMeasureMode,
  LayoutOverflow,
  LayoutPositionType,
  LayoutWrap,
} from '../../../src/tui/ink/layout/node.js'
import {
  YogaLayoutNode,
  createYogaLayoutNode,
} from '../../../src/tui/ink/layout/yoga.js'
import {
  Align,
  Display,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from '../../../src/tui/ink/native-ts/yoga-layout/index.js'

function node(): YogaLayoutNode {
  return createYogaLayoutNode() as YogaLayoutNode
}

describe('ink layout yoga coverage swarm row 099', () => {
  test('wraps yoga tree operations and parent lookup', () => {
    const root = node()
    const child = node()

    try {
      expect(root.getParent()).toBeNull()
      expect(root.getChildCount()).toBe(0)

      root.insertChild(child, 0)

      expect(root.getChildCount()).toBe(1)
      expect((child.getParent() as YogaLayoutNode).yoga).toBe(root.yoga)

      root.removeChild(child)

      expect(root.getChildCount()).toBe(0)
      expect(child.getParent()).toBeNull()
    } finally {
      child.free()
      root.free()
    }
  })

  test('translates yoga measure modes before calling layout measure functions', () => {
    const unconstrained = node()
    const row = node()
    const measured = node()
    const modes: LayoutMeasureMode[] = []

    try {
      unconstrained.setMeasureFunc((width, mode) => {
        modes.push(mode)
        expect(Number.isNaN(width)).toBe(true)
        return { width: 4, height: 1 }
      })
      unconstrained.calculateLayout()

      row.setFlexDirection(LayoutFlexDirection.Row)
      row.setWidth(20)
      row.setHeight(4)
      measured.setMeasureFunc((width, mode) => {
        modes.push(mode)
        if (mode === LayoutMeasureMode.AtMost) {
          expect(width).toBe(20)
        }
        return { width: Math.min(width, 6), height: 1 }
      })
      row.insertChild(measured, 0)
      row.calculateLayout(20)

      measured.setWidth(7)
      measured.markDirty()
      row.calculateLayout(20)

      expect(modes).toContain(LayoutMeasureMode.Undefined)
      expect(modes).toContain(LayoutMeasureMode.AtMost)
      expect(modes).toContain(LayoutMeasureMode.Exactly)

      measured.unsetMeasureFunc()
      expect(measured.yoga.measureFunc).toBeNull()
    } finally {
      row.freeRecursive()
      unconstrained.free()
    }
  })

  test('passes explicit height through to native yoga layout', () => {
    const root = node()
    const calculateLayout = vi.spyOn(root.yoga, 'calculateLayout')

    try {
      root.calculateLayout(12, 5)

      expect(calculateLayout).toHaveBeenCalledWith(12, 5, Direction.LTR)
    } finally {
      root.free()
    }
  })

  test('maps adapter style values to yoga enums and dimensions', () => {
    const subject = node()

    try {
      subject.setWidth(10)
      expect(subject.yoga.getWidth()).toEqual({ unit: Unit.Point, value: 10 })
      subject.setWidthPercent(50)
      expect(subject.yoga.getWidth()).toEqual({
        unit: Unit.Percent,
        value: 50,
      })
      subject.setWidthAuto()
      expect(subject.yoga.getWidth().unit).toBe(Unit.Auto)

      subject.setHeight(8)
      expect(subject.yoga.getHeight()).toEqual({ unit: Unit.Point, value: 8 })
      subject.setHeightPercent(40)
      expect(subject.yoga.getHeight()).toEqual({
        unit: Unit.Percent,
        value: 40,
      })
      subject.setHeightAuto()
      expect(subject.yoga.getHeight().unit).toBe(Unit.Auto)

      subject.setMinWidth(2)
      subject.setMinWidthPercent(25)
      subject.setMinHeight(3)
      subject.setMinHeightPercent(30)
      subject.setMaxWidth(12)
      subject.setMaxWidthPercent(75)
      subject.setMaxHeight(9)
      subject.setMaxHeightPercent(60)

      expect(subject.yoga.style.minWidth).toEqual({
        unit: Unit.Percent,
        value: 25,
      })
      expect(subject.yoga.style.minHeight).toEqual({
        unit: Unit.Percent,
        value: 30,
      })
      expect(subject.yoga.style.maxWidth).toEqual({
        unit: Unit.Percent,
        value: 75,
      })
      expect(subject.yoga.style.maxHeight).toEqual({
        unit: Unit.Percent,
        value: 60,
      })

      subject.setFlexDirection(LayoutFlexDirection.Row)
      expect(subject.yoga.getFlexDirection()).toBe(FlexDirection.Row)
      subject.setFlexDirection(LayoutFlexDirection.RowReverse)
      expect(subject.yoga.getFlexDirection()).toBe(FlexDirection.RowReverse)
      subject.setFlexDirection(LayoutFlexDirection.Column)
      expect(subject.yoga.getFlexDirection()).toBe(FlexDirection.Column)
      subject.setFlexDirection(LayoutFlexDirection.ColumnReverse)
      expect(subject.yoga.getFlexDirection()).toBe(FlexDirection.ColumnReverse)

      subject.setFlexGrow(2)
      subject.setFlexShrink(3)
      subject.setFlexBasis(5)
      expect(subject.yoga.getFlexGrow()).toBe(2)
      expect(subject.yoga.getFlexShrink()).toBe(3)
      expect(subject.yoga.getFlexBasis()).toEqual({
        unit: Unit.Point,
        value: 5,
      })
      subject.setFlexBasisPercent(15)
      expect(subject.yoga.getFlexBasis()).toEqual({
        unit: Unit.Percent,
        value: 15,
      })

      subject.setFlexWrap(LayoutWrap.NoWrap)
      expect(subject.yoga.getFlexWrap()).toBe(Wrap.NoWrap)
      subject.setFlexWrap(LayoutWrap.Wrap)
      expect(subject.yoga.getFlexWrap()).toBe(Wrap.Wrap)
      subject.setFlexWrap(LayoutWrap.WrapReverse)
      expect(subject.yoga.getFlexWrap()).toBe(Wrap.WrapReverse)

      subject.setAlignItems(LayoutAlign.Auto)
      expect(subject.yoga.getAlignItems()).toBe(Align.Auto)
      subject.setAlignItems(LayoutAlign.Stretch)
      expect(subject.yoga.getAlignItems()).toBe(Align.Stretch)
      subject.setAlignItems(LayoutAlign.FlexStart)
      expect(subject.yoga.getAlignItems()).toBe(Align.FlexStart)
      subject.setAlignItems(LayoutAlign.Center)
      expect(subject.yoga.getAlignItems()).toBe(Align.Center)
      subject.setAlignItems(LayoutAlign.FlexEnd)
      expect(subject.yoga.getAlignItems()).toBe(Align.FlexEnd)

      subject.setAlignSelf(LayoutAlign.Auto)
      expect(subject.yoga.getAlignSelf()).toBe(Align.Auto)
      subject.setAlignSelf(LayoutAlign.Stretch)
      expect(subject.yoga.getAlignSelf()).toBe(Align.Stretch)
      subject.setAlignSelf(LayoutAlign.FlexStart)
      expect(subject.yoga.getAlignSelf()).toBe(Align.FlexStart)
      subject.setAlignSelf(LayoutAlign.Center)
      expect(subject.yoga.getAlignSelf()).toBe(Align.Center)
      subject.setAlignSelf(LayoutAlign.FlexEnd)
      expect(subject.yoga.getAlignSelf()).toBe(Align.FlexEnd)

      subject.setJustifyContent(LayoutJustify.FlexStart)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.FlexStart)
      subject.setJustifyContent(LayoutJustify.Center)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.Center)
      subject.setJustifyContent(LayoutJustify.FlexEnd)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.FlexEnd)
      subject.setJustifyContent(LayoutJustify.SpaceBetween)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.SpaceBetween)
      subject.setJustifyContent(LayoutJustify.SpaceAround)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.SpaceAround)
      subject.setJustifyContent(LayoutJustify.SpaceEvenly)
      expect(subject.yoga.getJustifyContent()).toBe(Justify.SpaceEvenly)

      subject.setDisplay(LayoutDisplay.None)
      expect(subject.getDisplay()).toBe(LayoutDisplay.None)
      expect(subject.yoga.getDisplay()).toBe(Display.None)
      subject.setDisplay(LayoutDisplay.Flex)
      expect(subject.getDisplay()).toBe(LayoutDisplay.Flex)
      expect(subject.yoga.getDisplay()).toBe(Display.Flex)

      subject.setPositionType(LayoutPositionType.Absolute)
      expect(subject.yoga.getPositionType()).toBe(PositionType.Absolute)
      subject.setPositionType(LayoutPositionType.Relative)
      expect(subject.yoga.getPositionType()).toBe(PositionType.Relative)

      subject.setOverflow(LayoutOverflow.Visible)
      expect(subject.yoga.getOverflow()).toBe(Overflow.Visible)
      subject.setOverflow(LayoutOverflow.Hidden)
      expect(subject.yoga.getOverflow()).toBe(Overflow.Hidden)
      subject.setOverflow(LayoutOverflow.Scroll)
      expect(subject.yoga.getOverflow()).toBe(Overflow.Scroll)
    } finally {
      subject.free()
    }
  })

  test('maps layout edges and gutters for spacing, position, and computed reads', () => {
    const root = node()
    const child = node()
    const edgeCases = [
      [LayoutEdge.All, Edge.All],
      [LayoutEdge.Horizontal, Edge.Horizontal],
      [LayoutEdge.Vertical, Edge.Vertical],
      [LayoutEdge.Left, Edge.Left],
      [LayoutEdge.Right, Edge.Right],
      [LayoutEdge.Top, Edge.Top],
      [LayoutEdge.Bottom, Edge.Bottom],
      [LayoutEdge.Start, Edge.Start],
      [LayoutEdge.End, Edge.End],
    ] as const

    try {
      root.setWidth(100)
      root.setHeight(40)
      root.setFlexDirection(LayoutFlexDirection.Row)

      for (const [index, [layoutEdge, yogaEdge]] of edgeCases.entries()) {
        child.setMargin(layoutEdge, index + 1)
        child.setPadding(layoutEdge, index + 2)
        child.setBorder(layoutEdge, index + 3)
        child.setPosition(layoutEdge, index + 4)
        child.setPositionPercent(layoutEdge, index + 5)

        expect(child.yoga.style.margin[yogaEdge]).toEqual({
          unit: Unit.Point,
          value: index + 1,
        })
        expect(child.yoga.style.padding[yogaEdge]).toEqual({
          unit: Unit.Point,
          value: index + 2,
        })
        expect(child.yoga.style.border[yogaEdge]).toEqual({
          unit: Unit.Point,
          value: index + 3,
        })
        expect(child.yoga.style.position[yogaEdge]).toEqual({
          unit: Unit.Percent,
          value: index + 5,
        })
      }

      child.setGap(LayoutGutter.All, 1)
      child.setGap(LayoutGutter.Column, 2)
      child.setGap(LayoutGutter.Row, 3)
      expect(child.yoga.style.gap[Gutter.All]).toEqual({
        unit: Unit.Point,
        value: 1,
      })
      expect(child.yoga.style.gap[Gutter.Column]).toEqual({
        unit: Unit.Point,
        value: 2,
      })
      expect(child.yoga.style.gap[Gutter.Row]).toEqual({
        unit: Unit.Point,
        value: 3,
      })

      child.setWidth(10)
      child.setHeight(5)
      root.insertChild(child, 0)
      root.calculateLayout(100)

      expect(child.getComputedLeft()).toBeGreaterThanOrEqual(0)
      expect(child.getComputedTop()).toBeGreaterThanOrEqual(0)
      expect(child.getComputedWidth()).toBeGreaterThan(0)
      expect(child.getComputedHeight()).toBeGreaterThan(0)
      expect(child.getComputedBorder(LayoutEdge.Left)).toBe(
        child.yoga.getComputedBorder(Edge.Left),
      )
      expect(child.getComputedPadding(LayoutEdge.Left)).toBe(
        child.yoga.getComputedPadding(Edge.Left),
      )
    } finally {
      root.freeRecursive()
    }
  })
})
