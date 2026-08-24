import memoize from 'lodash-es/memoize.js'
import { getPlatform } from '../platform.js'

/**
 * Get the canonical managed configuration/assets directory.
 */
export const getManagedFilePath = memoize(function (): string {
  switch (getPlatform()) {
    case 'macos':
      return '/Library/Application Support/AgenC'
    case 'windows':
      return `${process.env.ProgramData ?? 'C:\\ProgramData'}\\AgenC`
    default:
      return '/etc/agenc'
  }
})
