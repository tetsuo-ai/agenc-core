import { useCallback, useEffect } from 'react'
import { settingsChangeDetector } from '../../agenc/upstream/utils/settings/changeDetector' // upstream-import: keep target is owned by another Z-PURGE item
import type { SettingSource } from '../../agenc/upstream/utils/settings/constants' // upstream-import: keep target is owned by another Z-PURGE item
import { getSettings_DEPRECATED } from '../../agenc/upstream/utils/settings/settings' // upstream-import: keep target is owned by another Z-PURGE item
import type { SettingsJson } from '../../agenc/upstream/utils/settings/types' // upstream-import: keep target is owned by another Z-PURGE item

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const handleChange = useCallback(
    (source: SettingSource) => {
      // Cache is already reset by the notifier (changeDetector.fanOut) —
      // resetting here caused N-way thrashing with N subscribers: each
      // cleared the cache, re-read from disk, then the next cleared again.
      const newSettings = getSettings_DEPRECATED()
      onChange(source, newSettings)
    },
    [onChange],
  )

  useEffect(
    () => settingsChangeDetector.subscribe(handleChange),
    [handleChange],
  )
}
