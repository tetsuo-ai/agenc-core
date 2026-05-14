export type ComputerUseGrantFlags = {
  clipboardRead?: boolean
  clipboardWrite?: boolean
  systemKeyCombos?: boolean
}

export type ComputerUseResolvedApp = {
  bundleId: string
  displayName: string
}

export type ComputerUseRequestedApp = {
  requestedName: string
  resolved?: ComputerUseResolvedApp
  alreadyGranted?: boolean
}

export type ComputerUseTccState = {
  accessibility: boolean
  screenRecording: boolean
}

export type ComputerUsePermissionRequest = {
  apps: readonly ComputerUseRequestedApp[]
  requestedFlags: ComputerUseGrantFlags
  reason?: string
  willHide?: readonly unknown[]
  tccState?: ComputerUseTccState
}

export type ComputerUseGrantedApp = ComputerUseResolvedApp & {
  grantedAt: number
}

export type ComputerUseDeniedApp = {
  bundleId: string
  reason: 'user_denied' | 'not_installed'
}

export type ComputerUsePermissionResponse = {
  granted: ComputerUseGrantedApp[]
  denied: ComputerUseDeniedApp[]
  flags: ComputerUseGrantFlags
}

export const DEFAULT_COMPUTER_USE_GRANT_FLAGS: ComputerUseGrantFlags = {}

export type ComputerUseSentinelCategory =
  | 'shell'
  | 'filesystem'
  | 'system_settings'

const SENTINEL_APP_CATEGORIES: Record<string, ComputerUseSentinelCategory> = {}

export function getComputerUseSentinelCategory(
  bundleId: string,
): ComputerUseSentinelCategory | undefined {
  return SENTINEL_APP_CATEGORIES[bundleId]
}
