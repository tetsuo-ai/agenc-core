import { useCallback, useEffect } from 'react'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { SettingSource } from '../../utils/settings/constants.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getInitialSettings } from '../../utils/settings/settings.js' // upstream-import: keep target is owned by another Z-PURGE item
import type { SettingsJson } from '../../utils/settings/types.js' // upstream-import: keep target is owned by another Z-PURGE item

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const handleChange = useCallback(
    (source: SettingSource) => {
      // Cache is already reset by the notifier (changeDetector.fanOut) —
      // resetting here caused N-way thrashing with N subscribers: each
      // cleared the cache, re-read from disk, then the next cleared again.
      const newSettings = getInitialSettings()
      onChange(source, newSettings)
    },
    [onChange],
  )

  useEffect(
    () => settingsChangeDetector.subscribe(handleChange),
    [handleChange],
  )
}
