import React from 'react'

import { TerminalSizeContext } from '../../../ink/components/TerminalSizeContext.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { truncateToWidthNoEllipsis } from '../../../../utils/truncate.js'

const DEFAULT_AGENT_WIZARD_COLUMNS = 80
const AGENT_WIZARD_HORIZONTAL_CHROME = 8
const AGENT_CONFIRMATION_PREVIEW_HORIZONTAL_CHROME = 10

export function getAgentWizardInputColumns(
  terminalColumns: number,
  preferredColumns: number,
): number {
  const safeTerminalColumns = Number.isFinite(terminalColumns)
    ? Math.max(0, Math.trunc(terminalColumns))
    : 0
  const safePreferredColumns = Number.isFinite(preferredColumns)
    ? Math.max(1, Math.trunc(preferredColumns))
    : DEFAULT_AGENT_WIZARD_COLUMNS
  return Math.max(
    1,
    Math.min(safePreferredColumns, safeTerminalColumns - AGENT_WIZARD_HORIZONTAL_CHROME),
  )
}

export function useAgentWizardInputColumns(preferredColumns: number): number {
  const terminalSize = React.useContext(TerminalSizeContext)
  return getAgentWizardInputColumns(
    terminalSize?.columns ?? DEFAULT_AGENT_WIZARD_COLUMNS,
    preferredColumns,
  )
}

export function getAgentConfirmationPreviewColumns(terminalColumns: number): number {
  const safeTerminalColumns = Number.isFinite(terminalColumns)
    ? Math.max(0, Math.trunc(terminalColumns))
    : 0
  return Math.max(
    1,
    safeTerminalColumns - AGENT_CONFIRMATION_PREVIEW_HORIZONTAL_CHROME,
  )
}

export function useAgentConfirmationPreviewColumns(): number {
  const terminalSize = React.useContext(TerminalSizeContext)
  return getAgentConfirmationPreviewColumns(
    terminalSize?.columns ?? DEFAULT_AGENT_WIZARD_COLUMNS,
  )
}

export function getAgentConfirmationPreviewText(
  text: string | undefined,
  maxColumns: number,
  ellipsis: string,
): string {
  const safeMaxColumns = Number.isFinite(maxColumns)
    ? Math.max(1, Math.trunc(maxColumns))
    : 1
  const safeText = text ?? ''
  if (stringWidth(safeText) <= safeMaxColumns) {
    return safeText
  }

  const safeEllipsis = ellipsis || '...'
  const ellipsisWidth = stringWidth(safeEllipsis)
  if (ellipsisWidth >= safeMaxColumns) {
    return truncateToWidthNoEllipsis(safeEllipsis, safeMaxColumns)
  }

  return `${truncateToWidthNoEllipsis(
    safeText,
    safeMaxColumns - ellipsisWidth,
  )}${safeEllipsis}`
}
