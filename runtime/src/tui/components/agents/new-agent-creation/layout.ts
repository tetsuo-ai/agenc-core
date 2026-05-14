import React from 'react'

import { TerminalSizeContext } from '../../../ink/components/TerminalSizeContext.js'

const DEFAULT_AGENT_WIZARD_COLUMNS = 80
const AGENT_WIZARD_HORIZONTAL_CHROME = 8

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
