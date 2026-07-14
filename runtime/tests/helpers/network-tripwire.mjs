// Default-suite public-network tripwire.
//
// This is defense in depth for accidental JavaScript network calls, not an OS
// security boundary. Native binaries/addons, UDP and direct DNS APIs, children
// that replace NODE_OPTIONS, restored originals, and loopback/IPC proxies can
// bypass it. Hosted CI that requires a hard egress guarantee must additionally
// use an isolated network namespace or firewall policy.

import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

export const PUBLIC_NETWORK_BLOCKED_CODE = 'AGENC_TEST_PUBLIC_NETWORK_BLOCKED'

const INSTALL_STATE = Symbol.for('agenc.test.public-network-tripwire.state')
const NETWORK_PROTOCOLS = new Set(['http:', 'https:'])
const LOOPBACKS = new net.BlockList()

LOOPBACKS.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACKS.addAddress('::1', 'ipv6')
LOOPBACKS.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

function unbracketHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1)
  }
  return host
}

/** Return true only for an omitted host or a literal loopback destination. */
export function isLoopbackHost(host) {
  if (host === undefined || host === null) return true
  if (typeof host !== 'string' || host.length === 0) return false

  const candidate = unbracketHost(host)
  if (candidate === 'localhost') return true

  const family = net.isIP(candidate)
  if (family === 4) return LOOPBACKS.check(candidate, 'ipv4')
  if (family === 6) return LOOPBACKS.check(candidate, 'ipv6')
  return false
}

function safeHostForMessage(host) {
  // A host must never turn terminal control bytes into log content. Keep the
  // diagnostic bounded and intentionally omit port, path, query, credentials,
  // request headers, and every other part of a URL/request.
  return host.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 255)
}

function blockedNetworkError(host) {
  const error = new Error(
    `${PUBLIC_NETWORK_BLOCKED_CODE}: blocked outbound host ${JSON.stringify(safeHostForMessage(host))}`,
  )
  error.name = 'AgenCTestNetworkBlockedError'
  error.code = PUBLIC_NETWORK_BLOCKED_CODE
  return error
}

function assertLoopbackHost(host) {
  if (host === undefined || host === null) return
  if (typeof host !== 'string') return
  if (!isLoopbackHost(host)) throw blockedNetworkError(host)
}

function connectHost(args) {
  const first = args[0]

  // net.connect(path) / socket.connect(path) is Unix-domain-socket or Windows
  // named-pipe IPC. Preserve the string overload exactly.
  if (typeof first === 'string') return undefined

  // net.connect(port[, host][, listener]); an omitted host defaults locally.
  if (typeof first === 'number') {
    return typeof args[1] === 'string' ? args[1] : undefined
  }

  if (first !== null && typeof first === 'object') {
    // A non-empty path selects IPC. Abstract Unix sockets (leading NUL) and
    // Windows named pipes are intentionally allowed by the JS-level guard.
    if (typeof first.path === 'string' && first.path.length > 0) return undefined
    return first.host
  }

  // Let Node retain its native argument-validation behavior.
  return undefined
}

function assertConnectArgs(args) {
  assertLoopbackHost(connectHost(args))
}

function fetchUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (
      typeof globalThis.Request === 'function' &&
      input instanceof globalThis.Request
    ) {
      return new URL(input.url)
    }
  } catch {
    // Preserve native fetch parsing/validation for malformed inputs.
  }
  return null
}

function assertFetchInput(input) {
  const url = fetchUrl(input)
  if (url === null || !NETWORK_PROTOCOLS.has(url.protocol)) return
  assertLoopbackHost(url.hostname)
}

function ensureChildPreload() {
  // Node children normally inherit NODE_OPTIONS. Appending (never replacing)
  // the preload keeps existing operator options intact. A child that supplies
  // a different env or strips NODE_OPTIONS is outside this JS guard's scope.
  const preload = `--import=${import.meta.url}`
  const current = process.env.NODE_OPTIONS?.trim() ?? ''
  if (current.split(/\s+/).includes(preload)) return
  process.env.NODE_OPTIONS = current === '' ? preload : `${current} ${preload}`
}

function applyInstalledState(state) {
  net.connect = state.guardedNetConnect
  net.createConnection = state.guardedCreateConnection
  net.Socket.prototype.connect = state.guardedSocketConnect
  tls.connect = state.guardedTlsConnect
  if (state.guardedFetch !== null) globalThis.fetch = state.guardedFetch

  // Built-in ESM named exports are snapshotted from their CommonJS export
  // objects. Synchronize them so `import { connect } from 'node:net'` and
  // `import { connect } from 'node:tls'` see the guarded functions too.
  syncBuiltinESMExports()
  ensureChildPreload()
}

/** Install or re-assert the idempotent public-network guard for this process. */
export function installNetworkTripwire() {
  const existing = globalThis[INSTALL_STATE]
  if (existing !== undefined) {
    applyInstalledState(existing)
    return existing
  }

  const originalNetConnect = net.connect
  const originalCreateConnection = net.createConnection
  const originalSocketConnect = net.Socket.prototype.connect
  const originalTlsConnect = tls.connect
  const originalFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch
    : null

  const state = {
    guardedNetConnect: function guardedNetConnect(...args) {
      assertConnectArgs(args)
      return Reflect.apply(originalNetConnect, this, args)
    },
    guardedCreateConnection: function guardedCreateConnection(...args) {
      assertConnectArgs(args)
      return Reflect.apply(originalCreateConnection, this, args)
    },
    guardedSocketConnect: function guardedSocketConnect(...args) {
      assertConnectArgs(args)
      return Reflect.apply(originalSocketConnect, this, args)
    },
    guardedTlsConnect: function guardedTlsConnect(...args) {
      assertConnectArgs(args)
      return Reflect.apply(originalTlsConnect, this, args)
    },
    guardedFetch: originalFetch === null
      ? null
      : function guardedFetch(...args) {
          try {
            assertFetchInput(args[0])
          } catch (error) {
            // Native fetch reports failures through its returned promise.
            return Promise.reject(error)
          }
          return Reflect.apply(originalFetch, this, args)
        },
  }

  Object.defineProperty(globalThis, INSTALL_STATE, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  })
  applyInstalledState(state)
  return state
}

// `node --import network-tripwire.mjs ...` must install before child code.
installNetworkTripwire()
