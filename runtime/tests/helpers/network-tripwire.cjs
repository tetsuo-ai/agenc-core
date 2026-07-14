'use strict'

// Synchronous CommonJS core for the default-suite public-network tripwire.
// Node does not run ESM `--import` preloads before CommonJS eval Worker source,
// while `--require` is synchronous for main processes, children, and Workers.

const { syncBuiltinESMExports } = require('node:module')
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const dgram = require('node:dgram')
const dns = require('node:dns')
const dnsPromises = require('node:dns/promises')
const net = require('node:net')
const path = require('node:path')
const tls = require('node:tls')
const workerThreads = require('node:worker_threads')

const PUBLIC_NETWORK_BLOCKED_CODE = 'AGENC_TEST_PUBLIC_NETWORK_BLOCKED'
const INSTALL_STATE = Symbol.for('agenc.test.public-network-tripwire.state')
const HERMETIC_RUNTIME_MARKER = Symbol.for(
  'agenc.test.hermetic-runtime.marker',
)
const HERMETIC_RUNTIME_MARKER_VERSION = 'agenc-hermetic-network-tripwire-v1'
const hermeticRunRoot =
  typeof process.env.AGENC_TEST_HERMETIC_RUN_ROOT === 'string' &&
  path.isAbsolute(process.env.AGENC_TEST_HERMETIC_RUN_ROOT)
    ? process.env.AGENC_TEST_HERMETIC_RUN_ROOT
    : undefined
const hermeticAttemptLedger =
  hermeticRunRoot !== undefined &&
  typeof process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER === 'string' &&
  path.isAbsolute(process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER) &&
  !path.relative(
    hermeticRunRoot,
    process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER,
  ).startsWith('..') &&
  !path.isAbsolute(path.relative(
    hermeticRunRoot,
    process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER,
  ))
    ? process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER
    : undefined
const HERMETIC_RUNTIME_MARKER_VALUE = Object.freeze({
  attemptLedger: hermeticAttemptLedger,
  runRoot: hermeticRunRoot,
  version: HERMETIC_RUNTIME_MARKER_VERSION,
})
const CONSUME_ATTEMPT = Symbol.for(
  'agenc.test.public-network-tripwire.consume-attempt',
)
const ATTEMPT_RECORD = Symbol('agenc.test.public-network-attempt-record')
const ATTEMPT_LEDGER_DIR = process.env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER
const outstandingAttemptRecords = new Set()
let attemptSequence = 0
const FETCH_PROTOCOLS = new Set(['http:', 'https:'])
const WEBSOCKET_PROTOCOLS = new Set(['ws:', 'wss:'])
const DNS_RESOLVE_METHODS = [...new Set([
  ...Reflect.ownKeys(dns),
  ...Reflect.ownKeys(dnsPromises),
  ...Reflect.ownKeys(dns.Resolver.prototype),
  ...Reflect.ownKeys(dnsPromises.Resolver.prototype),
].filter(name =>
  typeof name === 'string' && (name === 'reverse' || name.startsWith('resolve')),
))]
const DGRAM_MEMBERSHIP_METHODS = [
  'addMembership',
  'addSourceSpecificMembership',
  'dropMembership',
  'dropSourceSpecificMembership',
]
const PRELOAD_PATH = __filename
const LOOPBACKS = new net.BlockList()
const OriginalURL = globalThis.URL
const originalString = String
const originalUrlHostnameGetter = Object.getOwnPropertyDescriptor(
  OriginalURL.prototype,
  'hostname',
)?.get
const originalUrlProtocolGetter = Object.getOwnPropertyDescriptor(
  OriginalURL.prototype,
  'protocol',
)?.get
const originalRequestUrlGetter =
  typeof globalThis.Request === 'function'
    ? Object.getOwnPropertyDescriptor(globalThis.Request.prototype, 'url')?.get
    : undefined

LOOPBACKS.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACKS.addAddress('::1', 'ipv6')
LOOPBACKS.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

const existingHermeticMarker = Object.getOwnPropertyDescriptor(
  globalThis,
  HERMETIC_RUNTIME_MARKER,
)
if (existingHermeticMarker === undefined) {
  Object.defineProperty(globalThis, HERMETIC_RUNTIME_MARKER, {
    configurable: false,
    enumerable: false,
    value: HERMETIC_RUNTIME_MARKER_VALUE,
    writable: false,
  })
} else if (
  existingHermeticMarker.configurable !== false ||
  existingHermeticMarker.writable !== false ||
  existingHermeticMarker.value?.version !== HERMETIC_RUNTIME_MARKER_VERSION
) {
  throw new Error('AGENC_TEST_HERMETIC_MARKER_CONFLICT')
}

function attemptRecordPath() {
  if (typeof ATTEMPT_LEDGER_DIR !== 'string' || ATTEMPT_LEDGER_DIR === '') {
    return null
  }
  attemptSequence += 1
  const id = [
    process.pid,
    workerThreads.threadId,
    process.hrtime.bigint(),
    attemptSequence,
  ].join('-')
  return path.join(ATTEMPT_LEDGER_DIR, `${id}.attempt`)
}

function recordBlockedAttempt(error) {
  const recordPath = attemptRecordPath()
  const record = { path: recordPath }
  outstandingAttemptRecords.add(record)
  Object.defineProperty(error, ATTEMPT_RECORD, {
    configurable: false,
    enumerable: false,
    value: record,
    writable: false,
  })
  if (recordPath !== null) {
    try {
      mkdirSync(ATTEMPT_LEDGER_DIR, { recursive: true })
      // The record intentionally contains no destination or request data.
      // A bounded generic stack identifies the responsible test without
      // echoing the blocked host, URL, query, or request material.
      writeFileSync(recordPath, JSON.stringify({
        pid: process.pid,
        stack: originalString(error.stack ?? '').slice(0, 4096),
        threadId: workerThreads.threadId,
      }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch {
      // Preserve the in-process sticky record. The prelauncher also treats a
      // missing/tampered ledger directory as a failed hermetic run.
    }
  }
}

function consumeBlockedNetworkAttempt(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return false
  }
  const record = error[ATTEMPT_RECORD]
  if (record === undefined || !outstandingAttemptRecords.delete(record)) {
    return false
  }
  if (record.path !== null) {
    try {
      rmSync(record.path, { force: true })
    } catch {
      return false
    }
  }
  return true
}

const existingConsumer = Object.getOwnPropertyDescriptor(
  globalThis,
  CONSUME_ATTEMPT,
)
if (existingConsumer === undefined) {
  Object.defineProperty(globalThis, CONSUME_ATTEMPT, {
    configurable: false,
    enumerable: false,
    value: consumeBlockedNetworkAttempt,
    writable: false,
  })
}

process.once('exit', () => {
  if (outstandingAttemptRecords.size > 0) process.exitCode = 1
})

function unbracketHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1)
  }
  return host
}

function isExactLoopbackIp(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const family = net.isIP(host)
  if (family === 4) return LOOPBACKS.check(host, 'ipv4')
  if (family === 6) return LOOPBACKS.check(host, 'ipv6')
  return false
}

function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  return isExactLoopbackIp(unbracketHost(host))
}

function isAllowedIpcPath(path, platform = process.platform) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (platform !== 'win32') return true
  const normalized = path.toLowerCase()
  return (
    normalized.startsWith('\\\\.\\pipe\\') ||
    normalized.startsWith('\\\\?\\pipe\\')
  )
}

function blockedNetworkError() {
  // Do not echo the destination: raw host values may contain secrets, paths,
  // query strings, request material, or terminal controls.
  const error = new Error(
    `${PUBLIC_NETWORK_BLOCKED_CODE}: blocked non-loopback outbound connection`,
  )
  error.name = 'AgenCTestNetworkBlockedError'
  error.code = PUBLIC_NETWORK_BLOCKED_CODE
  recordBlockedAttempt(error)
  return error
}

function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) throw blockedNetworkError()
}

function canonicalizeDnsLookupArgs(args) {
  const canonical = Array.from(args)
  const hostname = originalString(canonical[0])
  // Numeric addresses require no resolver traffic. Destination-bearing APIs
  // (net/tls/dgram/fetch) enforce loopback separately; allowing numeric
  // lookup also preserves Node's internal UDP bind lookup for 0.0.0.0/::.
  if (net.isIP(hostname) === 0) {
    const normalized = hostname.toLowerCase().replace(/\.$/, '')
    if (normalized !== 'localhost') throw blockedNetworkError()
    return { canonical, hostname, localhost: true }
  }
  canonical[0] = hostname
  return { canonical, hostname, localhost: false }
}

function normalizeDnsLookupOptions(rawOptions) {
  const options = typeof rawOptions === 'number'
    ? { family: rawOptions }
    : rawOptions !== null && typeof rawOptions === 'object'
      ? rawOptions
      : {}
  let family = options.family ?? 0
  if (family === 'IPv4') family = 4
  if (family === 'IPv6') family = 6
  if (family !== 0 && family !== 4 && family !== 6) {
    const error = new TypeError('Invalid DNS lookup family')
    error.code = 'ERR_INVALID_ARG_VALUE'
    throw error
  }
  return {
    all: options.all === true,
    family,
    order: options.order === 'ipv6first' ? 'ipv6first' : 'ipv4first',
  }
}

function localhostDnsRecords(rawOptions) {
  const options = normalizeDnsLookupOptions(rawOptions)
  const ipv4 = { address: '127.0.0.1', family: 4 }
  const ipv6 = { address: '::1', family: 6 }
  let records
  if (options.family === 4) records = [ipv4]
  else if (options.family === 6) records = [ipv6]
  else records = options.order === 'ipv6first' ? [ipv6, ipv4] : [ipv4, ipv6]
  return { all: options.all, records }
}

function deterministicLocalhostLookupCallback(args) {
  const callback = args[args.length - 1]
  if (typeof callback !== 'function') {
    const error = new TypeError('The DNS lookup callback must be a function')
    error.code = 'ERR_INVALID_ARG_TYPE'
    throw error
  }
  const rawOptions = args.length > 2 ? args[1] : undefined
  const { all, records } = localhostDnsRecords(rawOptions)
  queueMicrotask(() => {
    if (all) callback(null, records)
    else callback(null, records[0].address, records[0].family)
  })
}

function deterministicLocalhostPromiseLookup(args) {
  const { all, records } = localhostDnsRecords(args[1])
  return Promise.resolve(all ? records : records[0])
}

function blockedDnsCallback() {
  throw blockedNetworkError()
}

function blockedDnsPromise() {
  return Promise.reject(blockedNetworkError())
}

function guardedDnsMethodMap(target, promiseMode) {
  const methods = {}
  for (const name of DNS_RESOLVE_METHODS) {
    if (typeof target[name] !== 'function') continue
    methods[name] = promiseMode ? blockedDnsPromise : blockedDnsCallback
  }
  return methods
}

function applyMethodMap(target, methods) {
  for (const [name, method] of Object.entries(methods)) target[name] = method
}

function canonicalizeRawLoopbackHost(value) {
  const host = originalString(value)
  const canonical = unbracketHost(host)
  if (!isExactLoopbackIp(canonical)) throw blockedNetworkError()
  return canonical
}

function defaultDgramLoopback(socket) {
  return socket.type === 'udp6' ? '::1' : '127.0.0.1'
}

function defaultDgramBindAddress(socket) {
  return socket.type === 'udp6' ? '::' : '0.0.0.0'
}

function snapshotDgramOptions(options) {
  const snapshot = {}
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined) continue
    const value = Reflect.get(options, key)
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value,
      writable: true,
    })
  }
  for (const key of ['address', 'fd', 'lookup', 'type']) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      const value = Reflect.get(options, key)
      if (value !== undefined) snapshot[key] = value
    }
  }
  return snapshot
}

function canonicalizeDgramCreateSocketArgs(args) {
  const canonical = Array.from(args)
  const options = canonical[0]
  if (options !== null && typeof options === 'object') {
    const snapshot = snapshotDgramOptions(options)
    // Node invokes a dgram socket's custom lookup even for numeric literals;
    // it could remap a validated loopback destination to a public address.
    if (snapshot.lookup !== undefined) throw blockedNetworkError()
    canonical[0] = snapshot
  }
  return canonical
}

function canonicalizeDgramConnectArgs(socket, args) {
  const canonical = Array.from(args)
  if (typeof canonical[1] === 'string') {
    canonical[1] = canonicalizeRawLoopbackHost(canonical[1])
  } else if (canonical[1] === undefined || typeof canonical[1] === 'function') {
    const address = defaultDgramLoopback(socket)
    if (typeof canonical[1] === 'function') canonical.splice(1, 0, address)
    else canonical[1] = address
  } else {
    throw blockedNetworkError()
  }
  return canonical
}

function canonicalizeDgramBindAddress(value) {
  const address = originalString(value)
  const canonical = unbracketHost(address)
  if (canonical !== '0.0.0.0' && canonical !== '::') {
    if (!isExactLoopbackIp(canonical)) throw blockedNetworkError()
  }
  return canonical
}

function canonicalizeDgramBindArgs(socket, args) {
  const canonical = Array.from(args)
  const first = canonical[0]
  if (first !== null && typeof first === 'object') {
    const options = snapshotDgramOptions(first)
    if (options.fd === undefined) {
      options.address = options.address === undefined
        ? defaultDgramBindAddress(socket)
        : canonicalizeDgramBindAddress(options.address)
    }
    canonical[0] = options
    return canonical
  }
  if (typeof canonical[1] === 'string') {
    canonical[1] = canonicalizeDgramBindAddress(canonical[1])
  } else if (
    (typeof first === 'number' || first === undefined) &&
    (canonical[1] === undefined || typeof canonical[1] === 'function')
  ) {
    const address = defaultDgramBindAddress(socket)
    if (typeof canonical[1] === 'function') canonical.splice(1, 0, address)
    else canonical[1] = address
  }
  return canonical
}

function canonicalizeDgramSendArgs(socket, args, connectedSockets) {
  const canonical = Array.from(args)
  let last = canonical.length - 1
  if (typeof canonical[last] === 'function') last -= 1

  if (last >= 1 && typeof canonical[last] === 'string') {
    canonical[last] = canonicalizeRawLoopbackHost(canonical[last])
    return canonical
  }

  if (
    last >= 2 &&
    (canonical[last] === null || canonical[last] === undefined)
  ) {
    canonical[last] = defaultDgramLoopback(socket)
    return canonical
  }

  // A connected UDP socket has no destination in send(); its connect() was
  // already validated. For an unconnected socket Node's safe omitted-address
  // overload defaults to the IP-family loopback; materialize that numeric
  // literal so no resolver or stateful default can change the destination.
  if (!connectedSockets.has(socket)) {
    if (last < 1 || typeof canonical[last] !== 'number') {
      throw blockedNetworkError()
    }
    canonical.splice(last + 1, 0, defaultDgramLoopback(socket))
  }
  return canonical
}

function connectTarget(args) {
  let normalizedArgs = args
  // net.createConnection normalizes its overloads, then calls Socket.connect
  // with that args array as the first argument. Unwrap a bounded number of
  // layers while rejecting pathological/circular input safely.
  for (let depth = 0; depth < 4 && Array.isArray(normalizedArgs[0]); depth += 1) {
    const nested = normalizedArgs[0]
    if (nested === normalizedArgs) return { kind: 'blocked' }
    normalizedArgs = nested
  }
  if (Array.isArray(normalizedArgs[0])) return { kind: 'blocked' }

  const first = normalizedArgs[0]
  if (typeof first === 'string') return { kind: 'ipc', path: first }
  if (typeof first === 'number') {
    return {
      kind: 'tcp',
      host: typeof normalizedArgs[1] === 'string'
        ? normalizedArgs[1]
        : undefined,
      setHost(host) {
        normalizedArgs[1] = host
      },
    }
  }
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string' && first.path.length > 0) {
      return { kind: 'ipc', path: first.path }
    }
    return {
      kind: 'tcp',
      host: first.host,
      setHost(host) {
        first.host = host
      },
    }
  }
  return { kind: 'native' }
}

function assertConnectArgs(args) {
  const target = connectTarget(args)
  if (target.kind === 'native') return
  if (target.kind === 'blocked') throw blockedNetworkError()
  if (target.kind === 'ipc') {
    if (!isAllowedIpcPath(target.path)) throw blockedNetworkError()
    return
  }
  // Omitted hosts and `localhost` are intentionally rejected. Both require
  // name resolution and can be redirected outside loopback. Bracketed IPv6
  // literals are accepted only after replacing the dispatched raw host with
  // its unbracketed numeric form; Node otherwise treats `[::1]` as a hostname
  // and invokes a caller-provided lookup function after validation.
  target.setHost(canonicalizeRawLoopbackHost(target.host))
}

function snapshotConnectOptions(options) {
  const snapshot = {}
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined) continue
    const value = Reflect.get(options, key)
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value,
      writable: true,
    })
  }

  // Node also accepts inherited overload properties. Materialize the two
  // destination-bearing fields once so the native implementation cannot
  // re-read a stateful prototype getter after validation.
  for (const key of ['host', 'path']) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      const value = Reflect.get(options, key)
      if (value !== undefined) snapshot[key] = value
    }
  }
  return snapshot
}

function canonicalizeConnectArgs(args, depth = 0, seen = new Set()) {
  if (depth > 4 || seen.has(args)) throw blockedNetworkError()
  seen.add(args)
  const canonical = Array.from(args)
  // Node tags the internal normalized-arguments array with a private Symbol.
  // Preserve symbol metadata while still copying destination values; dropping
  // it makes Socket.connect try to normalize the nested array a second time.
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'symbol') continue
    const descriptor = Object.getOwnPropertyDescriptor(args, key)
    if (descriptor !== undefined) {
      Object.defineProperty(canonical, key, descriptor)
    }
  }
  if (Array.isArray(canonical[0])) {
    canonical[0] = canonicalizeConnectArgs(canonical[0], depth + 1, seen)
  } else if (canonical[0] !== null && typeof canonical[0] === 'object') {
    canonical[0] = snapshotConnectOptions(canonical[0])
  }
  assertConnectArgs(canonical)
  return canonical
}

function parsedUrl(value) {
  try {
    return new OriginalURL(value)
  } catch {
    // Preserve native parsing/validation for malformed inputs.
    return null
  }
}

function intrinsicUrlParts(url) {
  if (
    originalUrlHostnameGetter === undefined ||
    originalUrlProtocolGetter === undefined
  ) {
    throw blockedNetworkError()
  }
  return {
    hostname: Reflect.apply(originalUrlHostnameGetter, url, []),
    protocol: Reflect.apply(originalUrlProtocolGetter, url, []),
  }
}

function assertFetchUrl(value) {
  const url = parsedUrl(value)
  // Native URL diagnostics echo malformed inputs verbatim. Fail with the same
  // generic redacted tripwire error instead of allowing credentials, query
  // strings, or terminal controls to reach an exception message.
  if (url === null) throw blockedNetworkError()
  const { hostname, protocol } = intrinsicUrlParts(url)
  if (FETCH_PROTOCOLS.has(protocol)) {
    assertLoopbackHost(hostname)
  }
}

function forceManualFetchRedirect(canonical) {
  const init = canonical[1]
  // Native fetch follows redirects inside undici, below the patched global
  // fetch/net surfaces. Shadow every caller-provided redirect value with
  // `manual` so a loopback response cannot redirect a hermetic test onto the
  // public network. Other RequestInit fields remain available through the
  // prototype, matching Web IDL dictionary lookup semantics.
  const guardedInit = init === undefined || init === null
    ? {}
    : Object.create(Object(init))
  Object.defineProperty(guardedInit, 'redirect', {
    configurable: false,
    enumerable: true,
    value: 'manual',
    writable: false,
  })
  canonical[1] = guardedInit
  return canonical
}

function canonicalizeFetchArgs(args) {
  const canonical = Array.from(args)
  const input = canonical[0]

  // Invoke the captured Request.prototype.url getter directly. This uses the
  // Request internal slot and cannot be fooled by a subclass overriding .url.
  if (
    originalRequestUrlGetter !== undefined &&
    input !== null &&
    (typeof input === 'object' || typeof input === 'function')
  ) {
    try {
      const requestUrl = Reflect.apply(originalRequestUrlGetter, input, [])
      assertFetchUrl(requestUrl)
      return forceManualFetchRedirect(canonical)
    } catch (error) {
      if (error?.code === PUBLIC_NETWORK_BLOCKED_CODE) throw error
      // Not a branded Request: use the native WebIDL string-coercion path.
    }
  }

  // Native fetch coerces non-Request inputs. Coerce exactly once, validate the
  // resulting URL, and pass that immutable string onward to prevent a
  // stateful toString() from changing the destination after the guard.
  const value = originalString(input)
  assertFetchUrl(value)
  canonical[0] = value
  return forceManualFetchRedirect(canonical)
}

function canonicalizeWebSocketArgs(args) {
  const canonical = Array.from(args)
  const value = originalString(canonical[0])
  const url = parsedUrl(value)
  if (url === null) throw blockedNetworkError()
  const { hostname, protocol } = intrinsicUrlParts(url)
  if (WEBSOCKET_PROTOCOLS.has(protocol)) {
    assertLoopbackHost(hostname)
  }
  canonical[0] = value
  return canonical
}

function hasWorkerPreload(execArgv) {
  return execArgv.some(
    (arg, index) =>
      arg === `--require=${PRELOAD_PATH}` ||
      (arg === '--require' && execArgv[index + 1] === PRELOAD_PATH),
  )
}

function workerOptionsWithPreload(options) {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    return options
  }
  const execArgv = options?.execArgv ?? process.execArgv
  if (!Array.isArray(execArgv)) return options

  // Worker `env: {}` and SHARE_ENV can otherwise remove the sticky ledger
  // before the preload runs. Snapshot either form into an ordinary isolated
  // environment and force the values captured by this parent preload.
  const requestedEnv = options?.env === workerThreads.SHARE_ENV
    ? process.env
    : options?.env ?? process.env
  const env = { ...requestedEnv }
  if (ATTEMPT_LEDGER_DIR !== undefined) {
    env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER = ATTEMPT_LEDGER_DIR
  }
  if (HERMETIC_RUNTIME_MARKER_VALUE.runRoot !== undefined) {
    env.AGENC_TEST_HERMETIC_RUN_ROOT = HERMETIC_RUNTIME_MARKER_VALUE.runRoot
  }

  return {
    ...(options ?? {}),
    env,
    execArgv: hasWorkerPreload(execArgv)
      ? [...execArgv]
      : [...execArgv, '--require', PRELOAD_PATH],
  }
}

function createGuardedWorker(originalWorker) {
  const GuardedWorker = class extends originalWorker {
    constructor(filename, options) {
      super(filename, workerOptionsWithPreload(options))
    }
  }
  Object.defineProperty(GuardedWorker, 'name', { value: 'Worker' })
  return GuardedWorker
}

function createGuardedDgramSocket(originalSocket) {
  return new Proxy(originalSocket, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        canonicalizeDgramCreateSocketArgs(args),
        newTarget,
      )
    },
  })
}

function createGuardedWebSocket(originalWebSocket) {
  return new Proxy(originalWebSocket, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        canonicalizeWebSocketArgs(args),
        newTarget,
      )
    },
  })
}

function ensureChildPreload() {
  const current = process.env.NODE_OPTIONS?.trim() ?? ''
  const preload = `--require ${JSON.stringify(PRELOAD_PATH)}`
  if (current.includes(preload)) return
  process.env.NODE_OPTIONS = current === '' ? preload : `${current} ${preload}`
}

function applyInstalledState(state) {
  dgram.Socket = state.guardedDgramSocket
  dgram.createSocket = state.guardedDgramCreateSocket
  dgram.Socket.prototype.bind = state.guardedDgramBind
  dgram.Socket.prototype.connect = state.guardedDgramConnect
  dgram.Socket.prototype.disconnect = state.guardedDgramDisconnect
  dgram.Socket.prototype.send = state.guardedDgramSend
  applyMethodMap(dgram.Socket.prototype, state.guardedDgramMembershipMethods)
  dns.lookup = state.guardedDnsLookup
  dns.lookupService = blockedDnsCallback
  dnsPromises.lookup = state.guardedDnsPromiseLookup
  dnsPromises.lookupService = blockedDnsPromise
  applyMethodMap(dns, state.guardedDnsMethods)
  applyMethodMap(dnsPromises, state.guardedDnsPromiseMethods)
  applyMethodMap(dns.Resolver.prototype, state.guardedResolverMethods)
  applyMethodMap(
    dnsPromises.Resolver.prototype,
    state.guardedPromiseResolverMethods,
  )
  net.connect = state.guardedNetConnect
  net.createConnection = state.guardedCreateConnection
  net.Socket.prototype.connect = state.guardedSocketConnect
  tls.connect = state.guardedTlsConnect
  workerThreads.Worker = state.guardedWorker
  if (state.guardedFetch !== null) globalThis.fetch = state.guardedFetch
  if (state.guardedWebSocket !== null) {
    globalThis.WebSocket = state.guardedWebSocket
  }
  syncBuiltinESMExports()
  ensureChildPreload()
}

function installNetworkTripwire() {
  const existing = globalThis[INSTALL_STATE]
  if (existing !== undefined) {
    applyInstalledState(existing)
    return existing
  }

  const originalNetConnect = net.connect
  const originalCreateConnection = net.createConnection
  const originalSocketConnect = net.Socket.prototype.connect
  const originalTlsConnect = tls.connect
  const originalWorker = workerThreads.Worker
  const originalDgramSocket = dgram.Socket
  const originalDgramCreateSocket = dgram.createSocket
  const originalDgramBind = dgram.Socket.prototype.bind
  const originalDgramConnect = dgram.Socket.prototype.connect
  const originalDgramDisconnect = dgram.Socket.prototype.disconnect
  const originalDgramSend = dgram.Socket.prototype.send
  const originalDnsLookup = dns.lookup
  const originalDnsPromiseLookup = dnsPromises.lookup
  const originalFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch
    : null
  const originalWebSocket = typeof globalThis.WebSocket === 'function'
    ? globalThis.WebSocket
    : null

  const state = {
    connectedDgramSockets: new WeakSet(),
    guardedDgramSocket: createGuardedDgramSocket(originalDgramSocket),
    guardedDgramCreateSocket: function guardedDgramCreateSocket(...args) {
      return Reflect.apply(
        originalDgramCreateSocket,
        this,
        canonicalizeDgramCreateSocketArgs(args),
      )
    },
    guardedDgramBind: function guardedDgramBind(...args) {
      return Reflect.apply(
        originalDgramBind,
        this,
        canonicalizeDgramBindArgs(this, args),
      )
    },
    guardedDgramConnect: null,
    guardedDgramDisconnect: null,
    guardedDgramSend: null,
    guardedDgramMembershipMethods: Object.fromEntries(
      DGRAM_MEMBERSHIP_METHODS.map(name => [name, function blockedMembership() {
        throw blockedNetworkError()
      }]),
    ),
    guardedDnsLookup: function guardedDnsLookup(...args) {
      const lookup = canonicalizeDnsLookupArgs(args)
      if (lookup.localhost) {
        return deterministicLocalhostLookupCallback(lookup.canonical)
      }
      return Reflect.apply(
        originalDnsLookup,
        this,
        lookup.canonical,
      )
    },
    guardedDnsMethods: guardedDnsMethodMap(dns, false),
    guardedDnsPromiseLookup: function guardedDnsPromiseLookup(...args) {
      let lookup
      try {
        lookup = canonicalizeDnsLookupArgs(args)
        if (lookup.localhost) {
          return deterministicLocalhostPromiseLookup(lookup.canonical)
        }
      } catch (error) {
        return Promise.reject(error)
      }
      return Reflect.apply(originalDnsPromiseLookup, this, lookup.canonical)
    },
    guardedDnsPromiseMethods: guardedDnsMethodMap(dnsPromises, true),
    guardedResolverMethods: guardedDnsMethodMap(dns.Resolver.prototype, false),
    guardedPromiseResolverMethods: guardedDnsMethodMap(
      dnsPromises.Resolver.prototype,
      true,
    ),
    guardedNetConnect: function guardedNetConnect(...args) {
      return Reflect.apply(
        originalNetConnect,
        this,
        canonicalizeConnectArgs(args),
      )
    },
    guardedCreateConnection: function guardedCreateConnection(...args) {
      return Reflect.apply(
        originalCreateConnection,
        this,
        canonicalizeConnectArgs(args),
      )
    },
    guardedSocketConnect: function guardedSocketConnect(...args) {
      return Reflect.apply(
        originalSocketConnect,
        this,
        canonicalizeConnectArgs(args),
      )
    },
    guardedTlsConnect: function guardedTlsConnect(...args) {
      return Reflect.apply(
        originalTlsConnect,
        this,
        canonicalizeConnectArgs(args),
      )
    },
    guardedWorker: createGuardedWorker(originalWorker),
    guardedFetch: originalFetch === null
      ? null
      : function guardedFetch(...args) {
          try {
            args = canonicalizeFetchArgs(args)
          } catch (error) {
            return Promise.reject(error)
          }
          return Reflect.apply(originalFetch, this, args)
        },
    guardedWebSocket: originalWebSocket === null
      ? null
      : createGuardedWebSocket(originalWebSocket),
  }

  state.guardedDgramConnect = function guardedDgramConnect(...args) {
    const canonical = canonicalizeDgramConnectArgs(this, args)
    state.connectedDgramSockets.add(this)
    try {
      return Reflect.apply(originalDgramConnect, this, canonical)
    } catch (error) {
      state.connectedDgramSockets.delete(this)
      throw error
    }
  }
  state.guardedDgramDisconnect = function guardedDgramDisconnect(...args) {
    state.connectedDgramSockets.delete(this)
    return Reflect.apply(originalDgramDisconnect, this, args)
  }
  state.guardedDgramSend = function guardedDgramSend(...args) {
    return Reflect.apply(
      originalDgramSend,
      this,
      canonicalizeDgramSendArgs(this, args, state.connectedDgramSockets),
    )
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

module.exports = {
  consumeBlockedNetworkAttempt: globalThis[CONSUME_ATTEMPT],
  installNetworkTripwire,
  isAllowedIpcPath,
  isLoopbackHost,
  PUBLIC_NETWORK_BLOCKED_CODE,
}

installNetworkTripwire()
