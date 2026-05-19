import * as React from 'react'
import { useMemo, useState } from 'react'

import {
  DEFAULT_COMPUTER_USE_GRANT_FLAGS,
  getComputerUseSentinelCategory,
  type ComputerUsePermissionRequest,
  type ComputerUsePermissionResponse,
  type ComputerUseRequestedApp,
} from '../../utils/computerUse/approvalTypes.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js' // upstream-import: keep target is owned by another Z-PURGE item
import { plural } from '../../utils/stringUtils.js' // upstream-import: keep target is owned by another Z-PURGE item
import { Box, Text } from '../ink.js'
import type { OptionWithDescription } from '../components/CustomSelect/select.js'
import { Select } from '../components/CustomSelect/select.js'
import { Dialog } from '../components/design-system/Dialog.js'
import { selectComputerUseApprovalGlyphs } from './computerUseGlyphs.js'

type ComputerUseApprovalProps = {
  request: ComputerUsePermissionRequest
  onDone: (response: ComputerUsePermissionResponse) => void
}

const DENY_ALL_RESPONSE: ComputerUsePermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_COMPUTER_USE_GRANT_FLAGS,
}

/**
 * Two-panel dispatcher. When `request.tccState` is present, macOS permissions
 * (Accessibility / Screen Recording) are missing and the app list is
 * irrelevant; otherwise show the app allowlist + grant-flags panel.
 */
export function ComputerUseApproval({
  request,
  onDone,
}: ComputerUseApprovalProps): React.ReactNode {
  if (request.tccState) {
    return (
      <ComputerUseTccPanel
        tccState={request.tccState}
        onDone={() => onDone(DENY_ALL_RESPONSE)}
      />
    )
  }

  return <ComputerUseAppListPanel request={request} onDone={onDone} />
}

type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry'

function ComputerUseTccPanel({
  tccState,
  onDone,
}: {
  tccState: NonNullable<ComputerUsePermissionRequest['tccState']>
  onDone: () => void
}): React.ReactNode {
  const options = useMemo<OptionWithDescription<TccOption>[]>(() => {
    const next: OptionWithDescription<TccOption>[] = []

    if (!tccState.accessibility) {
      next.push({
        label: 'Open System Settings -> Accessibility',
        value: 'open_accessibility',
      })
    }

    if (!tccState.screenRecording) {
      next.push({
        label: 'Open System Settings -> Screen Recording',
        value: 'open_screen_recording',
      })
    }

    next.push({
      label: 'Try again',
      value: 'retry',
    })

    return next
  }, [tccState.accessibility, tccState.screenRecording])

  const onChange = (value: TccOption): void => {
    switch (value) {
      case 'open_accessibility':
        execFileNoThrow(
          'open',
          [
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
          ],
          { useCwd: false },
        )
        return
      case 'open_screen_recording':
        execFileNoThrow(
          'open',
          [
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
          ],
          { useCwd: false },
        )
        return
      case 'retry':
        onDone()
        return
    }
  }

  const glyphs = selectComputerUseApprovalGlyphs()
  const accessibilityStatus = tccState.accessibility
    ? `${glyphs.granted} granted`
    : `${glyphs.denied} not granted`
  const screenRecordingStatus = tccState.screenRecording
    ? `${glyphs.granted} granted`
    : `${glyphs.denied} not granted`

  return (
    <Dialog title="Computer Use needs macOS permissions" onCancel={onDone}>
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        <Box flexDirection="column">
          <Text>Accessibility: {accessibilityStatus}</Text>
          <Text>Screen Recording: {screenRecordingStatus}</Text>
        </Box>
        <Text dimColor>
          Grant the missing permissions in System Settings, then select "Try
          again". macOS may require you to restart AgenC after granting Screen
          Recording.
        </Text>
        <Select options={options} onChange={onChange} onCancel={onDone} />
      </Box>
    </Dialog>
  )
}

type AppToggleOption = `app:${string}`
type AppListOption = AppToggleOption | 'allow_selected' | 'deny'

const SENTINEL_WARNING: Record<
  NonNullable<ReturnType<typeof getComputerUseSentinelCategory>>,
  string
> = {
  shell: 'equivalent to shell access',
  filesystem: 'can read/write any file',
  system_settings: 'can change system settings',
}

function toAppOptionValue(bundleId: string): AppToggleOption {
  return `app:${bundleId}`
}

function getAppBundleIdFromOption(value: AppListOption): string | undefined {
  return value.startsWith('app:') ? value.slice(4) : undefined
}

function isSelectableApp(
  app: ComputerUseRequestedApp,
): app is ComputerUseRequestedApp & {
  resolved: NonNullable<ComputerUseRequestedApp['resolved']>
} {
  return Boolean(app.resolved && !app.alreadyGranted)
}

export function getInitialComputerUseSelectedAppIds(
  apps: readonly ComputerUseRequestedApp[],
): string[] {
  return apps.filter(isSelectableApp).map(app => app.resolved.bundleId)
}

function ComputerUseAppListPanel({
  request,
  onDone,
}: ComputerUseApprovalProps): React.ReactNode {
  const selectableApps = useMemo(
    () => request.apps.filter(isSelectableApp),
    [request.apps],
  )
  const initialSelectedIds = useMemo(
    () => getInitialComputerUseSelectedAppIds(request.apps),
    [request.apps],
  )
  const [selectedAppIds, setSelectedAppIds] = useState(initialSelectedIds)
  const selectedAppIdSet = useMemo(
    () => new Set(selectedAppIds),
    [selectedAppIds],
  )
  const requestedFlagKeys = useMemo(
    () =>
      (['clipboardRead', 'clipboardWrite', 'systemKeyCombos'] as const).filter(
        key => request.requestedFlags[key],
      ),
    [request.requestedFlags],
  )
  const glyphs = selectComputerUseApprovalGlyphs()

  const respond = (allow: boolean): void => {
    if (!allow) {
      onDone(DENY_ALL_RESPONSE)
      return
    }

    const now = Date.now()
    const granted = selectableApps
      .filter(app => selectedAppIdSet.has(app.resolved.bundleId))
      .map(app => ({
        bundleId: app.resolved.bundleId,
        displayName: app.resolved.displayName,
        grantedAt: now,
      }))
    const denied = request.apps
      .filter(app => {
        if (!app.resolved) return true
        if (app.alreadyGranted) return false
        return !selectedAppIdSet.has(app.resolved.bundleId)
      })
      .map(app => ({
        bundleId: app.resolved?.bundleId ?? app.requestedName,
        reason: app.resolved ? ('user_denied' as const) : ('not_installed' as const),
      }))
    const flags = {
      ...DEFAULT_COMPUTER_USE_GRANT_FLAGS,
      ...Object.fromEntries(requestedFlagKeys.map(key => [key, true] as const)),
    }

    onDone({
      granted,
      denied,
      flags,
    })
  }

  const options = useMemo<OptionWithDescription<AppListOption>[]>(() => {
    const appOptions = selectableApps.map(app => {
      const bundleId = app.resolved.bundleId
      const sentinel = getComputerUseSentinelCategory(bundleId)
      const selected = selectedAppIdSet.has(bundleId)
      return {
        label: (
          <Text>
            {selected ? glyphs.selectedApp : glyphs.unselectedApp}{' '}
            {app.resolved.displayName}
          </Text>
        ),
        value: toAppOptionValue(bundleId),
        description: sentinel
          ? `${glyphs.warning} ${SENTINEL_WARNING[sentinel]}`
          : undefined,
      } satisfies OptionWithDescription<AppListOption>
    })

    const selectedCount = selectedAppIds.length
    const selectedLabel = `Allow selected for this session (${selectedCount} ${plural(
      selectedCount,
      'app',
    )})`

    return [
      ...appOptions,
      {
        label: selectedLabel,
        value: 'allow_selected',
      },
      {
        label: (
          <Text>
            Deny, and tell AgenC what to do differently{' '}
            <Text bold>(esc)</Text>
          </Text>
        ),
        value: 'deny',
      },
    ]
  }, [selectableApps, selectedAppIdSet, selectedAppIds.length])

  const onChange = (value: AppListOption): void => {
    const bundleId = getAppBundleIdFromOption(value)
    if (bundleId) {
      setSelectedAppIds(prev =>
        prev.includes(bundleId)
          ? prev.filter(id => id !== bundleId)
          : [...prev, bundleId],
      )
      return
    }

    respond(value === 'allow_selected')
  }

  const nonSelectableRows = request.apps.flatMap(app => {
    if (!app.resolved) {
      return [
        <Text key={app.requestedName} dimColor>
          {'  '}
          {glyphs.unselectedApp} {app.requestedName}{' '}
          <Text dimColor>(not installed)</Text>
        </Text>,
      ]
    }

    if (app.alreadyGranted) {
      return [
        <Text key={app.resolved.bundleId} dimColor>
          {'  '}
          {glyphs.granted} {app.resolved.displayName}{' '}
          <Text dimColor>(already granted)</Text>
        </Text>,
      ]
    }

    return []
  })

  return (
    <Dialog
      title="Computer Use wants to control these apps"
      onCancel={() => respond(false)}
    >
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        {request.reason ? <Text dimColor>{request.reason}</Text> : null}
        {nonSelectableRows.length > 0 ? (
          <Box flexDirection="column">{nonSelectableRows}</Box>
        ) : null}
        {requestedFlagKeys.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>Also requested:</Text>
            {requestedFlagKeys.map(flag => (
              <Text key={flag} dimColor>
                {'  '}{glyphs.bullet} {flag}
              </Text>
            ))}
          </Box>
        ) : null}
        {request.willHide && request.willHide.length > 0 ? (
          <Text dimColor>
            {request.willHide.length} other {plural(request.willHide.length, 'app')}{' '}
            will be hidden while AgenC works.
          </Text>
        ) : null}
        <Select
          options={options}
          onChange={onChange}
          onCancel={() => respond(false)}
          visibleOptionCount={Math.min(10, options.length)}
        />
      </Box>
    </Dialog>
  )
}
