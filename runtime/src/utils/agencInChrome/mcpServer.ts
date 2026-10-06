import {
  type AgenCForChromeContext,
  createAgenCForChromeMcpServer,
  type Logger,
  type PermissionMode,
} from '@ant/agenc-for-chrome-mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { format } from 'util'
import { getAgenCAIOAuthTokens, getOauthAccountInfo } from '../auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from '../secureStorage/native.js'
import {
  captureSecureStorageIngress,
  resolveSecureStorageHome,
} from '../secureStorage/home.js'
import { getAllSocketPaths, getSecureSocketPath } from './common.js'
import {
  snapshotProviderEnvironment,
  type ProviderEnvironment,
} from '../../llm/provider-options.js'
import type { HomeContext } from '../../config/home.js'

const EXTENSION_DOWNLOAD_URL = 'https://agenc.tech/chrome'
const BUG_REPORT_URL =
  'https://github.com/tetsuo-ai/agenc-core/issues/new?labels=bug,agenc-in-chrome'

const PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'skip_all_permission_checks',
  'follow_a_plan',
]

function isPermissionMode(raw: string): raw is PermissionMode {
  return PERMISSION_MODES.some(m => m === raw)
}

/**
 * The hosted Chrome bridge is not part of this runtime; native messaging is
 * the only transport.
 */
function getChromeBridgeUrl(
  _environment: ProviderEnvironment,
): string | undefined {
  return undefined
}

function isLocalBridge(environment: ProviderEnvironment): boolean {
  return (
    isEnvTruthy(environment.USE_LOCAL_OAUTH) ||
    isEnvTruthy(environment.LOCAL_BRIDGE)
  )
}

/**
 * Build the AgenCForChromeContext used by both the subprocess MCP server
 * and the in-process path in the MCP client.
 */
export function createChromeContext(
  providerEnvironment: ProviderEnvironment,
  env?: Record<string, string>,
  explicitHome?: HomeContext,
): AgenCForChromeContext {
  const environment: ProviderEnvironment = Object.freeze({
    ...providerEnvironment,
    ...(env ?? {}),
  })
  const home = explicitHome ?? resolveSecureStorageHome(environment)
  const logger = new DebugLogger()
  const chromeBridgeUrl = getChromeBridgeUrl(environment)
  logger.info(`Bridge URL: ${chromeBridgeUrl ?? 'none (using native socket)'}`)
  const rawPermissionMode =
    environment.AGENC_CHROME_PERMISSION_MODE
  let initialPermissionMode: PermissionMode | undefined
  if (rawPermissionMode) {
    if (isPermissionMode(rawPermissionMode)) {
      initialPermissionMode = rawPermissionMode
    } else {
      logger.warn(
        `Invalid AGENC_CHROME_PERMISSION_MODE "${rawPermissionMode}". Valid values: ${PERMISSION_MODES.join(', ')}`,
      )
    }
  }
  return {
    serverName: 'AgenC in Chrome',
    logger,
    socketPath: getSecureSocketPath(),
    getSocketPaths: getAllSocketPaths,
    clientTypeId: 'agenc-code',
    onAuthenticationError: () => {
      logger.warn(
        'Authentication error occurred. Please ensure you are logged into the AgenC browser extension with the same AgenC account as AgenC.',
      )
    },
    onToolCallDisconnected: () => {
      return `Browser extension is not connected. Please ensure the AgenC browser extension is installed and running (${EXTENSION_DOWNLOAD_URL}), and that you are logged into AgenC with the same account as AgenC. If this is your first time connecting to Chrome, you may need to restart Chrome for the installation to take effect. If you continue to experience issues, please report a bug: ${BUG_REPORT_URL}`
    },
    onExtensionPaired: (deviceId: string, name: string) => {
      updateNativeSecureStorage(home, current => {
        if (
          current.chromePairingIdentity?.pairedDeviceId === deviceId &&
          current.chromePairingIdentity?.pairedDeviceName === name
        ) return { ...current }
        return {
          ...current,
          chromePairingIdentity: {
            pairedDeviceId: deviceId,
            pairedDeviceName: name,
          },
        }
      }, 'Native secure storage is unavailable; the Chrome pairing was not saved.')
      logger.info(`Paired with "${name}" (${deviceId.slice(0, 8)})`)
    },
    getPersistedDeviceId: () => {
      return readNativeSecureStorage(home).chromePairingIdentity?.pairedDeviceId
    },
    ...(chromeBridgeUrl && {
      bridgeConfig: {
        url: chromeBridgeUrl,
        getUserId: async () => {
          return getOauthAccountInfo(home)?.accountUuid
        },
        getOAuthToken: async () => {
          return getAgenCAIOAuthTokens(home, environment)?.accessToken ?? ''
        },
        ...(isLocalBridge(environment) && { devUserId: 'dev_user_local' }),
      },
    }),
    ...(initialPermissionMode && { initialPermissionMode }),
    trackEvent: (_eventName: any, _metadata: any) => {},
  }
}

export async function runAgenCInChromeMcpServer(): Promise<void> {
  const ingress = captureSecureStorageIngress(process.env)
  const context = createChromeContext(
    snapshotProviderEnvironment(ingress.environment),
    undefined,
    ingress.home,
  )

  const server = createAgenCForChromeMcpServer(context)
  const transport = new StdioServerTransport()

  // Exit when parent process dies (stdin pipe closes).
  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[AgenC in Chrome] Starting MCP server')
  await server.connect(transport)
  logForDebugging('[AgenC in Chrome] MCP server started')
}

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}
