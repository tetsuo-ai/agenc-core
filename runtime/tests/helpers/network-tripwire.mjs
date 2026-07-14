// ESM facade for the synchronous CommonJS preload core. Keeping all policy in
// one implementation makes main Vitest workers, child processes, and CommonJS
// eval Worker threads enforce the same destination rules.

import tripwire from './network-tripwire.cjs'

export const PUBLIC_NETWORK_BLOCKED_CODE =
  tripwire.PUBLIC_NETWORK_BLOCKED_CODE
export const consumeBlockedNetworkAttempt =
  tripwire.consumeBlockedNetworkAttempt
export const installNetworkTripwire = tripwire.installNetworkTripwire
export const isAllowedIpcPath = tripwire.isAllowedIpcPath
export const isLoopbackHost = tripwire.isLoopbackHost

installNetworkTripwire()
