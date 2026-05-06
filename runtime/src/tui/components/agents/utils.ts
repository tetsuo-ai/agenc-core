import capitalize from 'lodash-es/capitalize.js'
import type { SettingSource } from '../../../agenc/upstream/utils/settings/constants.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getSettingSourceName } from '../../../agenc/upstream/utils/settings/constants.js' // upstream-import: keep target is owned by another Z-PURGE item

export function getAgentSourceDisplayName(
  source: SettingSource | 'all' | 'built-in' | 'plugin',
): string {
  if (source === 'all') {
    return 'Agents'
  }
  if (source === 'built-in') {
    return 'Built-in agents'
  }
  if (source === 'plugin') {
    return 'Plugin agents'
  }
  return capitalize(getSettingSourceName(source))
}
