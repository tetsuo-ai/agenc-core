import type * as Undici from 'undici'

type DispatcherGlobals = Pick<typeof Undici, 'getGlobalDispatcher' | 'setGlobalDispatcher'>
let globals: DispatcherGlobals | undefined

/**
 * Load Undici's dispatcher implementation without its fetch, WebSocket, mock
 * and cache entrypoints. Keep the same constructors and global dispatcher as
 * the full package, including the public methods index.js adds to Dispatcher.
 * These package paths are checked against the locked Undici by identity tests.
 * Keep this outside the relocated utils tree, whose build resolver externalizes
 * package imports: both this core and later full imports must share one bundle.
 */
function loadDispatcherCore(): DispatcherGlobals {
  if (globals !== undefined) return globals
  // Literal requires let the runtime bundler share these exact CJS modules
  // with a later full Undici import instead of creating another module copy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Dispatcher = require('undici/lib/dispatcher/dispatcher.js') as typeof Undici.Dispatcher
  if (!Object.hasOwn(Dispatcher.prototype, 'request')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Object.assign(Dispatcher.prototype, require('undici/lib/api/index.js'))
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('undici/lib/global.js') as Partial<DispatcherGlobals>
  if (typeof loaded.getGlobalDispatcher !== 'function' || typeof loaded.setGlobalDispatcher !== 'function') {
    throw new Error('Undici dispatcher globals are unavailable')
  }
  globals = loaded as DispatcherGlobals
  return globals
}

export function getUndiciGlobalDispatcher(): Undici.Dispatcher {
  return loadDispatcherCore().getGlobalDispatcher()
}

export function loadUndiciAgent(): typeof Undici.Agent {
  loadDispatcherCore()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('undici/lib/dispatcher/agent.js') as typeof Undici.Agent
}

export function loadUndiciEnvHttpProxyAgent(): typeof Undici.EnvHttpProxyAgent {
  loadDispatcherCore()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('undici/lib/dispatcher/env-http-proxy-agent.js') as typeof Undici.EnvHttpProxyAgent
}
