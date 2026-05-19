import { stringWidth } from '../../ink/stringWidth.js'
import type { AgenCTuiGlyphs } from '../../glyphs.js'
import { getGraphemeSegmenter } from '../../../utils/intl.js'

const TEAMS_DIALOG_HORIZONTAL_PADDING = 4
const TEAMS_DIALOG_FOOTER_MARGIN = 1
const PROMPT_EXPAND_HINT = ' (p to expand)'

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0
}

function truncateWithEllipsis(
  text: string,
  maxColumns: number,
  ellipsis: string,
): string {
  if (stringWidth(text) <= maxColumns) return text
  if (maxColumns <= 0) return ''
  if (maxColumns <= stringWidth(ellipsis)) {
    return ellipsis.slice(0, maxColumns)
  }

  let width = 0
  let result = ''
  const available = maxColumns - stringWidth(ellipsis)
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > available) break
    result += segment
    width += segmentWidth
  }

  return `${result}${ellipsis}`
}

export function getTeamsDialogContentColumns(columns: number): number {
  return Math.max(1, normalizeColumns(columns) - TEAMS_DIALOG_HORIZONTAL_PADDING)
}

export function fitTeamsDialogFooter(
  text: string,
  columns: number,
  ellipsis: string,
): string {
  const width = Math.max(1, normalizeColumns(columns) - TEAMS_DIALOG_FOOTER_MARGIN)
  return truncateWithEllipsis(text, width, ellipsis)
}

export function getTeamListFooterText(args: {
  glyphs: AgenCTuiGlyphs
  supportsHideShow: boolean
  cycleModeShortcut: string
  columns: number
}): string {
  const { glyphs, supportsHideShow, cycleModeShortcut, columns } = args
  const separator = ` ${glyphs.separator} `
  const text = [
    `${glyphs.arrowUp}/${glyphs.arrowDown} select`,
    'Enter view',
    'k kill',
    's shutdown',
    'p prune idle',
    ...(supportsHideShow ? ['h hide/show', 'H hide/show all'] : []),
    `${cycleModeShortcut} sync cycle modes for all`,
    'Esc close',
  ].join(separator)
  return fitTeamsDialogFooter(text, columns, glyphs.ellipsis)
}

export function getTeammateDetailFooterText(args: {
  glyphs: AgenCTuiGlyphs
  supportsHideShow: boolean
  cycleModeShortcut: string
  columns: number
}): string {
  const { glyphs, supportsHideShow, cycleModeShortcut, columns } = args
  const separator = ` ${glyphs.separator} `
  const text = [
    'Left back',
    'Esc close',
    'k kill',
    's shutdown',
    ...(supportsHideShow ? ['h hide/show'] : []),
    `${cycleModeShortcut} cycle mode`,
  ].join(separator)
  return fitTeamsDialogFooter(text, columns, glyphs.ellipsis)
}

export function getTeamsDialogPromptPreview(
  prompt: string | undefined,
  columns: number,
  expanded: boolean,
  ellipsis: string,
): { text: string; showExpandHint: boolean } {
  const safePrompt = prompt ?? ''
  if (expanded || safePrompt === '') {
    return { text: safePrompt, showExpandHint: false }
  }

  const width = getTeamsDialogContentColumns(columns)
  if (stringWidth(safePrompt) <= width) {
    return { text: safePrompt, showExpandHint: false }
  }

  const canShowHint = width > stringWidth(PROMPT_EXPAND_HINT) + 1
  const previewWidth = canShowHint
    ? width - stringWidth(PROMPT_EXPAND_HINT)
    : width

  return {
    text: truncateWithEllipsis(safePrompt, previewWidth, ellipsis),
    showExpandHint: canShowHint,
  }
}
