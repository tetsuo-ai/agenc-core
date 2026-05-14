import { describe, expect, it } from 'vitest'

import {
  getElicitationAccordionOptionLimit,
  getElicitationExpandedFieldRows,
  getElicitationFieldBodyRows,
  getElicitationOptionWindow,
  getElicitationRenderGlyphs,
  getElicitationScrollWindow,
  getElicitationTextInputColumns,
  getResolvingSpinnerFrames,
} from './ElicitationDialog.js'

describe('ElicitationDialog layout helpers', () => {
  it('keeps text inputs usable on narrow or invalid terminals', () => {
    expect(getElicitationTextInputColumns(Number.NaN)).toBe(1)
    expect(getElicitationTextInputColumns(0)).toBe(1)
    expect(getElicitationTextInputColumns(19)).toBe(1)
    expect(getElicitationTextInputColumns(21.9)).toBe(1)
    expect(getElicitationTextInputColumns(40)).toBe(20)
    expect(getElicitationTextInputColumns(120)).toBe(60)
  })

  it('caps expanded accordions to the available field body budget', () => {
    expect(getElicitationFieldBodyRows(10)).toBe(3)
    expect(getElicitationFieldBodyRows(24)).toBe(10)
    expect(getElicitationAccordionOptionLimit(24)).toBe(5)
    expect(getElicitationAccordionOptionLimit(40)).toBe(8)
    expect(getElicitationExpandedFieldRows(20, 24)).toBe(10)
    expect(getElicitationExpandedFieldRows(2, 24)).toBe(5)
  })

  it('windows accordion options around the focused option', () => {
    expect(getElicitationOptionWindow(20, 0, 5)).toEqual({
      start: 0,
      end: 5,
    })
    expect(getElicitationOptionWindow(20, 10, 5)).toEqual({
      start: 8,
      end: 13,
    })
    expect(getElicitationOptionWindow(20, 19, 5)).toEqual({
      start: 15,
      end: 20,
    })
  })

  it('computes field windows from row heights instead of field counts', () => {
    expect(getElicitationScrollWindow([3, 3, 3], 1, 10)).toEqual({
      start: 0,
      end: 3,
    })
    expect(getElicitationScrollWindow([3, 3, 10, 3], 2, 10)).toEqual({
      start: 2,
      end: 3,
    })
    expect(getElicitationScrollWindow([3, 3, 10, 3], undefined, 10)).toEqual({
      start: 3,
      end: 4,
    })
  })

  it('uses ascii-safe elicitation glyphs when requested', () => {
    const glyphs = getElicitationRenderGlyphs({ AGENC_TUI_GLYPHS: 'ascii' })

    expect(Object.values(glyphs).join('')).toMatch(/^[\x00-\x7F]*$/)
    expect(glyphs).toMatchObject({
      arrowDown: 'v',
      arrowLeft: '<',
      arrowRight: '>',
      arrowUp: '^',
      checkboxOn: 'x',
      ellipsis: '...',
      pointer: '>',
      radioOn: '*',
      warning: '!',
    })
  })

  it('uses ascii-safe resolving spinner frames when requested', () => {
    expect(getResolvingSpinnerFrames({ AGENC_TUI_GLYPHS: 'ascii' })).toEqual([
      '-',
      '\\',
      '|',
      '/',
    ])
  })
})
