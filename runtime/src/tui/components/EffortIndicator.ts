import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from '../../constants/figures.js' // upstream-import: keep target is owned by another Z-PURGE item
import {
  type AvailableEffortLevel,
  type EffortValue,
  getDisplayedEffortLevelForContext,
  getSessionEffortLabelForContext,
  modelSupportsEffortForContext,
} from '../../utils/effort.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { ProviderAuthReadContext } from '../../utils/auth.js'

/**
 * Build the text for the effort-changed notification, e.g. "◐ medium · /effort".
 * Returns undefined if the model doesn't support effort.
 */
export function getEffortNotificationText(
  effortValue: EffortValue | 'none' | undefined,
  model: string,
  context: ProviderAuthReadContext,
): string | undefined {
  if (!modelSupportsEffortForContext(model, context)) return undefined
  const label = getSessionEffortLabelForContext(model, effortValue, context)
  if (label === null) return 'model default · /effort'
  if (label === 'effort off') return 'effort off · /effort'
  const level = getDisplayedEffortLevelForContext(model, effortValue === 'none' ? undefined : effortValue, context)
  return `${effortLevelToSymbol(level)} ${level} · /effort`
}

export function effortLevelToSymbol(level: AvailableEffortLevel): string {
  switch (level) {
    case 'minimal':
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'max':
    case 'xhigh':
      return EFFORT_MAX
    default:
      // Defensive: level can originate from remote config. If an unknown
      // value slips through, render the high symbol rather than undefined.
      return EFFORT_HIGH
  }
}
