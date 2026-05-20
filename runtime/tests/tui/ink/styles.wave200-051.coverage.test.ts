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
  LayoutWrap,
  type LayoutNode,
} from './layout/node.ts'
import applyStyles, { type Styles } from './styles.ts'

function createLayoutNode(): LayoutNode {
  return {
    setPositionType: vi.fn(),
    setPosition: vi.fn(),
    setPositionPercent: vi.fn(),
    setOverflow: vi.fn(),
    setMargin: vi.fn(),
    setPadding: vi.fn(),
    setFlexGrow: vi.fn(),
    setFlexShrink: vi.fn(),
    setFlexWrap: vi.fn(),
    setFlexDirection: vi.fn(),
    setFlexBasis: vi.fn(),
    setFlexBasisPercent: vi.fn(),
    setAlignItems: vi.fn(),
    setAlignSelf: vi.fn(),
    setJustifyContent: vi.fn(),
    setWidth: vi.fn(),
    setWidthPercent: vi.fn(),
    setWidthAuto: vi.fn(),
    setHeight: vi.fn(),
    setHeightPercent: vi.fn(),
    setHeightAuto: vi.fn(),
    setMinWidth: vi.fn(),
    setMinWidthPercent: vi.fn(),
    setMinHeight: vi.fn(),
    setMinHeightPercent: vi.fn(),
    setMaxWidth: vi.fn(),
    setMaxWidthPercent: vi.fn(),
    setMaxHeight: vi.fn(),
    setMaxHeightPercent: vi.fn(),
    setDisplay: vi.fn(),
    setBorder: vi.fn(),
    setGap: vi.fn(),
  } as unknown as LayoutNode
}

function expectPositionCall(
  node: LayoutNode,
  edge: (typeof LayoutEdge)[keyof typeof LayoutEdge],
  value: number,
): void {
  expect(
    vi
      .mocked(node.setPosition)
      .mock.calls.some(([actualEdge, actualValue]) => {
        return actualEdge === edge && Object.is(actualValue, value)
      }),
  ).toBe(true)
}

test('maps less common style branches to layout node setters', () => {
  const node = createLayoutNode()

  applyStyles(
    node,
    {
      position: 'absolute',
      top: '25%',
      bottom: undefined,
      left: 3,
      right: undefined,
      overflowX: 'hidden',
      overflowY: 'visible',
      margin: undefined,
      marginX: 0,
      marginY: 2,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 4,
      marginBottom: 0,
      padding: undefined,
      paddingX: 1,
      paddingY: 0,
      paddingLeft: 0,
      paddingRight: 5,
      paddingTop: 0,
      paddingBottom: 6,
      flexGrow: undefined,
      flexShrink: undefined,
      flexWrap: 'wrap-reverse',
      flexDirection: 'row-reverse',
      flexBasis: '45%',
      alignItems: undefined,
      alignSelf: 'center',
      justifyContent: 'space-evenly',
      width: undefined,
      height: '40%',
      minWidth: '25%',
      minHeight: '30%',
      maxWidth: undefined,
      maxHeight: '80%',
      display: 'flex',
      borderStyle: 'single',
      borderTop: false,
      borderBottom: true,
      borderLeft: false,
      borderRight: true,
      gap: undefined,
      columnGap: undefined,
      rowGap: 4,
    } as Styles,
    {
      borderStyle: 'single',
      borderTop: false,
      borderBottom: true,
      borderLeft: false,
      borderRight: true,
    } as Styles,
  )

  applyStyles(node, {
    flexWrap: 'nowrap',
    flexDirection: 'column-reverse',
    flexBasis: undefined,
    alignSelf: 'auto',
    justifyContent: 'space-around',
    height: undefined,
    maxWidth: '70%',
    display: 'none',
    borderRight: false,
    columnGap: 0,
  } as Styles)

  applyStyles(node, {
    overflow: 'scroll',
    flexWrap: 'wrap',
    flexDirection: 'column',
    alignSelf: 'flex-start',
    justifyContent: 'flex-start',
    maxHeight: undefined,
    rowGap: undefined,
  } as Styles)

  expect(node.setPositionType).toHaveBeenCalledWith(LayoutPositionType.Absolute)
  expect(node.setPositionPercent).toHaveBeenCalledWith(LayoutEdge.Top, 25)
  expectPositionCall(node, LayoutEdge.Bottom, Number.NaN)
  expect(node.setPosition).toHaveBeenCalledWith(LayoutEdge.Left, 3)
  expectPositionCall(node, LayoutEdge.Right, Number.NaN)
  expect(node.setOverflow).toHaveBeenCalledWith(LayoutOverflow.Hidden)
  expect(node.setOverflow).toHaveBeenCalledWith(LayoutOverflow.Scroll)

  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.All, 0)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.Horizontal, 0)
  expect(node.setMargin).toHaveBeenCalledWith(LayoutEdge.End, 0)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.All, 0)
  expect(node.setPadding).toHaveBeenCalledWith(LayoutEdge.Left, 0)

  expect(node.setFlexGrow).toHaveBeenCalledWith(0)
  expect(node.setFlexShrink).toHaveBeenCalledWith(1)
  expect(node.setFlexWrap).toHaveBeenCalledWith(LayoutWrap.WrapReverse)
  expect(node.setFlexWrap).toHaveBeenCalledWith(LayoutWrap.NoWrap)
  expect(node.setFlexWrap).toHaveBeenCalledWith(LayoutWrap.Wrap)
  expect(node.setFlexDirection).toHaveBeenCalledWith(
    LayoutFlexDirection.RowReverse,
  )
  expect(node.setFlexDirection).toHaveBeenCalledWith(
    LayoutFlexDirection.ColumnReverse,
  )
  expect(node.setFlexDirection).toHaveBeenCalledWith(LayoutFlexDirection.Column)
  expect(node.setFlexBasisPercent).toHaveBeenCalledWith(45)
  expect(node.setFlexBasis).toHaveBeenCalledWith(Number.NaN)
  expect(node.setAlignItems).toHaveBeenCalledWith(LayoutAlign.Stretch)
  expect(node.setAlignSelf).toHaveBeenCalledWith(LayoutAlign.Center)
  expect(node.setAlignSelf).toHaveBeenCalledWith(LayoutAlign.Auto)
  expect(node.setAlignSelf).toHaveBeenCalledWith(LayoutAlign.FlexStart)
  expect(node.setJustifyContent).toHaveBeenCalledWith(LayoutJustify.SpaceEvenly)
  expect(node.setJustifyContent).toHaveBeenCalledWith(LayoutJustify.SpaceAround)
  expect(node.setJustifyContent).toHaveBeenCalledWith(LayoutJustify.FlexStart)

  expect(node.setWidthAuto).toHaveBeenCalled()
  expect(node.setHeightPercent).toHaveBeenCalledWith(40)
  expect(node.setHeightAuto).toHaveBeenCalled()
  expect(node.setMinWidthPercent).toHaveBeenCalledWith(25)
  expect(node.setMinHeightPercent).toHaveBeenCalledWith(30)
  expect(node.setMaxWidth).toHaveBeenCalledWith(0)
  expect(node.setMaxWidthPercent).toHaveBeenCalledWith(70)
  expect(node.setMaxHeightPercent).toHaveBeenCalledWith(80)
  expect(node.setMaxHeight).toHaveBeenCalledWith(0)
  expect(node.setDisplay).toHaveBeenCalledWith(LayoutDisplay.Flex)
  expect(node.setDisplay).toHaveBeenCalledWith(LayoutDisplay.None)

  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Top, 0)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Bottom, 1)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Left, 0)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Right, 1)
  expect(node.setBorder).toHaveBeenCalledWith(LayoutEdge.Right, 0)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.All, 0)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.Column, 0)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.Row, 4)
  expect(node.setGap).toHaveBeenCalledWith(LayoutGutter.Row, 0)
})
