import { describe, expect, test } from 'vitest'

import Yoga, {
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  PositionType,
  Wrap,
} from '../vendored/yoga-layout/index.js'
import {
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
} from './node.js'
import { createYogaLayoutNode } from './yoga.js'

describe('AgenC Yoga layout contract', () => {
  test('adapter preserves flex growth, padding, borders, and dirty relayout', () => {
    const root = createYogaLayoutNode()
    const fixed = createYogaLayoutNode()
    const flexible = createYogaLayoutNode()

    root.setFlexDirection(LayoutFlexDirection.Row)
    root.setWidth(40)
    root.setPadding(LayoutEdge.Left, 2)
    root.setBorder(LayoutEdge.Left, 1)

    fixed.setWidth(10)
    flexible.setFlexGrow(1)

    root.insertChild(fixed, 0)
    root.insertChild(flexible, 1)

    root.calculateLayout(40)

    expect(fixed.getComputedLeft()).toBe(3)
    expect(fixed.getComputedWidth()).toBe(10)
    expect(flexible.getComputedLeft()).toBe(13)
    expect(flexible.getComputedWidth()).toBe(27)
    expect(root.getComputedPadding(LayoutEdge.Left)).toBe(2)
    expect(root.getComputedBorder(LayoutEdge.Left)).toBe(1)

    root.setWidth(50)
    root.calculateLayout(50)

    expect(flexible.getComputedLeft()).toBe(13)
    expect(flexible.getComputedWidth()).toBe(37)

    root.freeRecursive()
  })

  test('adapter preserves gap and percentage sizing used by TUI rows', () => {
    const root = createYogaLayoutNode()
    const half = createYogaLayoutNode()
    const rest = createYogaLayoutNode()

    root.setFlexDirection(LayoutFlexDirection.Row)
    root.setWidth(40)
    root.setGap(LayoutGutter.Column, 2)

    half.setWidthPercent(50)
    rest.setFlexGrow(1)

    root.insertChild(half, 0)
    root.insertChild(rest, 1)
    root.calculateLayout(40)

    expect(half.getComputedWidth()).toBe(20)
    expect(rest.getComputedLeft()).toBe(22)
    expect(rest.getComputedWidth()).toBe(18)

    root.freeRecursive()
  })

  test('vendored Yoga supports wrapping and align-content semantics', () => {
    const root = Yoga.Node.create()
    const first = Yoga.Node.create()
    const second = Yoga.Node.create()
    const third = Yoga.Node.create()

    root.setFlexDirection(FlexDirection.Row)
    root.setFlexWrap(Wrap.Wrap)
    root.setAlignContent(Align.FlexStart)
    root.setWidth(10)

    for (const child of [first, second, third]) {
      child.setWidth(6)
      child.setHeight(1)
      root.insertChild(child, root.getChildCount())
    }

    root.calculateLayout(10, undefined, Direction.LTR)

    expect(root.getComputedHeight()).toBe(3)
    expect(first.getComputedLeft()).toBe(0)
    expect(first.getComputedTop()).toBe(0)
    expect(second.getComputedLeft()).toBe(0)
    expect(second.getComputedTop()).toBe(1)
    expect(third.getComputedLeft()).toBe(0)
    expect(third.getComputedTop()).toBe(2)

    root.freeRecursive()
  })

  test('vendored Yoga handles display none without reserving terminal columns', () => {
    const root = Yoga.Node.create()
    const hidden = Yoga.Node.create()
    const visible = Yoga.Node.create()

    root.setFlexDirection(FlexDirection.Row)
    root.setWidth(20)
    hidden.setWidth(10)
    hidden.setDisplay(Display.None)
    visible.setWidth(5)

    root.insertChild(hidden, 0)
    root.insertChild(visible, 1)
    root.calculateLayout(20, undefined, Direction.LTR)

    expect(hidden.getComputedWidth()).toBe(0)
    expect(visible.getComputedLeft()).toBe(0)
    expect(visible.getComputedWidth()).toBe(5)

    root.freeRecursive()
  })

  test('vendored Yoga keeps absolute children positioned against the parent box', () => {
    const root = Yoga.Node.create()
    const child = Yoga.Node.create()

    root.setWidth(30)
    root.setHeight(10)
    root.setPadding(Edge.Left, 2)
    root.setPadding(Edge.Top, 1)

    child.setPositionType(PositionType.Absolute)
    child.setPosition(Edge.Left, 4)
    child.setPosition(Edge.Top, 3)
    child.setWidth(5)
    child.setHeight(2)

    root.insertChild(child, 0)
    root.calculateLayout(30, 10, Direction.LTR)

    expect(child.getComputedLeft()).toBe(4)
    expect(child.getComputedTop()).toBe(3)
    expect(child.getComputedWidth()).toBe(5)
    expect(child.getComputedHeight()).toBe(2)

    root.freeRecursive()
  })

  test('vendored Yoga remeasures dirty text nodes between frames', () => {
    const root = Yoga.Node.create()
    const measured = Yoga.Node.create()
    let width = 4

    measured.setMeasureFunc(() => ({ width, height: 1 }))
    root.insertChild(measured, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(root.getComputedWidth()).toBe(4)
    expect(measured.getComputedWidth()).toBe(4)

    width = 9
    measured.markDirty()
    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(root.getComputedWidth()).toBe(9)
    expect(measured.getComputedWidth()).toBe(9)

    root.freeRecursive()
  })
})
