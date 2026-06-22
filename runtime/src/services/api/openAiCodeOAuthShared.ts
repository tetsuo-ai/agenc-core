import { asRecord } from '../../utils/record.js'

const PROVIDER_CODE_OAUTH_ISSUER = 'https://auth.openai.com'
export const PROVIDER_CODE_REFRESH_URL = `${PROVIDER_CODE_OAUTH_ISSUER}/oauth/token`
const DEFAULT_PROVIDER_CODE_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const DEFAULT_PROVIDER_CODE_OAUTH_CALLBACK_PORT = 1455
export const PROVIDER_CODE_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const PROVIDER_CODE_OAUTH_ORIGINATOR = 'providerCode_cli_rs'
const PROVIDER_CODE_API_KEY_TOKEN_NAME = 'openai-api-key'
const PROVIDER_CODE_ID_TOKEN_SUBJECT_TYPE =
  'urn:ietf:params:oauth:token-type:id_token'
const PROVIDER_CODE_TOKEN_EXCHANGE_GRANT =
  'urn:ietf:params:oauth:grant-type:token-exchange'

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export type OAuthTokenPayload = {
  accessToken?: string
  refreshToken?: string
  idToken?: string
}

export function normalizeOAuthTokenPayload(value: unknown): OAuthTokenPayload {
  const record = asRecord(value)
  if (!record) return {}
  const accessToken = asTrimmedString(record.access_token)
  const refreshToken = asTrimmedString(record.refresh_token)
  const idToken = asTrimmedString(record.id_token)
  return {
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
  }
}

export async function readOAuthTokenJsonResponse(
  response: Response,
  operation: string,
): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(`${operation} returned invalid JSON.`)
  }
}

export function getOpenAiCodeOAuthClientId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return asTrimmedString(env.PROVIDER_CODE_OAUTH_CLIENT_ID) ?? DEFAULT_PROVIDER_CODE_OAUTH_CLIENT_ID
}

export function getOpenAiCodeOAuthCallbackPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawPort = asTrimmedString(env.PROVIDER_CODE_OAUTH_CALLBACK_PORT)
  if (!rawPort) {
    return DEFAULT_PROVIDER_CODE_OAUTH_CALLBACK_PORT
  }

  const parsed = Number.parseInt(rawPort, 10)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed
  }

  return DEFAULT_PROVIDER_CODE_OAUTH_CALLBACK_PORT
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined

  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function parseChatgptAccountId(
  token: string | undefined,
): string | undefined {
  if (!token) return undefined

  const payload = decodeJwtPayload(token)
  const nestedAuth =
    payload?.['https://api.openai.com/auth'] &&
    typeof payload['https://api.openai.com/auth'] === 'object'
      ? (payload['https://api.openai.com/auth'] as Record<string, unknown>)
      : undefined

  return (
    asTrimmedString(
      nestedAuth?.chatgpt_account_id ??
        payload?.['https://api.openai.com/auth.chatgpt_account_id'] ??
        payload?.chatgpt_account_id,
    ) ?? undefined
  )
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case '\'':
        return '&#39;'
      default:
        return char
    }
  })
}

export async function exchangeProviderCodeIdTokenForApiKey(
  idToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: PROVIDER_CODE_TOKEN_EXCHANGE_GRANT,
    client_id: getOpenAiCodeOAuthClientId(),
    requested_token: PROVIDER_CODE_API_KEY_TOKEN_NAME,
    subject_token: idToken,
    subject_token_type: PROVIDER_CODE_ID_TOKEN_SUBJECT_TYPE,
  })

  const response = await fetch(PROVIDER_CODE_REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(
      bodyText.trim()
        ? `ProviderCode API key exchange failed (${response.status}): ${bodyText.trim()}`
        : `ProviderCode API key exchange failed with status ${response.status}.`,
    )
  }

  const payload = normalizeOAuthTokenPayload(
    await readOAuthTokenJsonResponse(
      response,
      'ProviderCode API key exchange',
    ),
  )
  const apiKey = payload.accessToken
  if (!apiKey) {
    throw new Error(
      'ProviderCode API key exchange completed, but no API key token was returned.',
    )
  }

  return apiKey
}
