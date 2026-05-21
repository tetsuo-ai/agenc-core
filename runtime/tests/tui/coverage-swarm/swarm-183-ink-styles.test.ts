import { expect, test, vi } from 'vitest'

import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  LayoutOverflow,
  LayoutPositionType,
  type LayoutNode,
} from '../../../src/tui/ink/layout/node.ts'
import applyStyles, { type Styles } from '../../../src/tui/ink/styles.ts'

function createLayoutNode(): LayoutNode {
  return {
    setAlignItems: vi.fn(),
    setAlignSelf: vi.fn(),
    setBorder: vi.fn(),
    setDisplay: vi.fn(),
    setFlexBasis: vi.fn(),
    setFlexBasisPercent: vi.fn(),
    setFlexDirection: vi.fn(),
    setFlexGrow: vi.fn(),
    setFlexShrink: vi.fn(),
    setFlexWrap: vi.fn(),
    setGap: vi.fn(),
    setHeight: vi.fn(),
    setHeightAuto: vi.fn(),
    setHeightPercent: vi.fn(),
    setJustifyContent: vi.fn(),
    setMargin: vi.fn(),
    setMaxHeight: vi.fn(),
    setMaxHeightPercent: vi.fn(),
    setMaxWidth: vi.fn(),
    setMaxWidthPercent: vi.fn(),
    setMinHeight: vi.fn(),
    setMinHeightPercent: vi.fn(),
    setMinWidth: vi.fn(),
    setMinWidthPercent: vi.fn(),
    setOverflow: vi.fn(),
    setPadding: vi.fn(),
    setPosition: vi.fn(),
    setPositionPercent: vi.fn(),
    setPositionType: vi.fn(),
    setWidth: vi.fn(),
    setWidthAuto: vi.fn(),
    setWidthPercent: vi.fn(),
  } as unknown as LayoutNode
}

test('maps concrete style values to layout node setters', () => {
  const node = createLayoutNode()

  applyStyles(node, {
    alignItems: 'flex-start',
    alignSelf: 'flex-end',
    columnGap: 3,
    display: 'flex',
    flexBasis: 7,
    flexDirection: 'row',
    flexGrow: 2,
    flexShrink: 3,
    gap: 2,
    height: 5,
    justifyContent: 'center',
    marginBottom: 8,
    marginLeft: 4,
    marginRight: 6,
    marginTop: 7,
    maxHeight: 11,
    maxWidth: 10,
    minHeight: 9,
    minWidth: 8,
    overflow: 'visible',
    paddingBottom: 12,
    paddingLeft: 9,
    paddingRight: 10,
    paddingTop: 11,
    position: 'relative',
    rowGap: 4,
    width: 12,
  })

  expect(node.setPositionType).toHaveBeenCalledWith(
    LayoutPositionType.Relative,
  )
  expect(node.setOverflow).toHaveBeenCalledWith(LayoutOverflow.Visible)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.Start, 4)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.End, 6)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.Top, 7)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.Bottom, 8)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.Left, 9)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.Right, 10)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.Top, 11)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.Bottom, 12)
  expect(node.setFlexGrow).toHaveBeenCalledWith(2)
  expect(node.setFlexShrink).toHaveBeenCalledWith(3)
  expect(node.setFlexDirection).toHaveBeenCalledWith(LayoutFlexDirection.Row)
  expect(node.setFlexBasis).toHaveBeenCalledWith(7)
  expect(node.setAlignItems).toHaveBeenCalledWith(LayoutAlign.FlexStart)
  expect(node.setAlignSelf).toHaveBeenCalledWith(LayoutAlign.FlexEnd)
  expect(node.setJustifyContent).toHaveBeenCalledWith(LayoutJustify.Center)
  expect(node.setWidth).toHaveBeenCalledWith(12)
  expect(node.setHeight).toHaveBeenCalledWith(5)
  expect(node.setMinWidth).toHaveBeenCalledWith(8)
  expect(node.setMinHeight).toHaveBeenCalledWith(9)
  expect(node.setMaxWidth).toHaveBeenCalledWith(10)
  expect(node.setMaxHeight).toHaveBeenCalledWith(11)
  expect(node.setDisplay).toHaveBeenCalledWith(LayoutDisplay.Flex)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.All, 2)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.Column, 3)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.Row, 4)
})

test('maps remaining alignment and individual border branches', () => {
  const node = createLayoutNode()

  applyStyles(node, {
    alignItems: 'center',
    borderBottom: false,
    borderLeft: undefined,
    borderRight: true,
    borderTop: true,
    justifyContent: 'flex-end',
  } as Styles)

  applyStyles(node, {
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  })

  expect(node.setAlignItems).toHaveBeenCalledWith(LayoutAlign.Center)
  expect(node.setAlignItems).toHaveBeenCalledWith(LayoutAlign.FlexEnd)
  expect(node.setJustifyContent).toHaveBeenCalledWith(LayoutJustify.FlexEnd)
  expect(node.setJustifyContent).toHaveBeenCalledWith(
    LayoutJustify.SpaceBetween,
  )
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Top, 1)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Bottom, 0)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Right, 1)
  expect(node.setBorder).not.toHaveBeenCalledWith(LayoutEdge.Left, 0)
  expect(node.setBorder).not.toHaveBeenCalledWith(LayoutEdge.Left, 1)
})
