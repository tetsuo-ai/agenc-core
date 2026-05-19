import { isEnvTruthy } from 'src/utils/envUtils.js'

// Default to prod config, override with test/staging if enabled
type OauthConfigType = 'prod' | 'staging' | 'local'

function getOauthConfigType(): OauthConfigType {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
      return 'local'
    }
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
      return 'staging'
    }
  }
  return 'prod'
}

export function fileSuffixForOauthConfig(): string {
  if (process.env.AGENC_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'
  }
  switch (getOauthConfigType()) {
    case 'local':
      return '-local-oauth'
    case 'staging':
      return '-staging-oauth'
    case 'prod':
      // No suffix for production config
      return ''
  }
}

export const AGENC_AI_INFERENCE_SCOPE = 'user:inference' as const
export const AGENC_AI_PROFILE_SCOPE = 'user:profile' as const
const CONSOLE_SCOPE = 'org:create_api_key' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

// Console OAuth scopes - for API key creation via Console
export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  AGENC_AI_PROFILE_SCOPE,
] as const

// AgenC cloud OAuth scopes - for AgenC subscribers (Pro/Max/Team/Enterprise)
export const AGENC_AI_OAUTH_SCOPES = [
  AGENC_AI_PROFILE_SCOPE,
  AGENC_AI_INFERENCE_SCOPE,
  'user:sessions:agenc_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

// All OAuth scopes - union of all scopes used in AgenC CLI.
// When logging in, request all scopes in order to handle both Console and
// AgenC cloud redirects.
// Ensure that `OAuthConsentPage` in apps repo is kept in sync with this list.
export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...AGENC_AI_OAUTH_SCOPES]),
)

type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  AGENC_AI_AUTHORIZE_URL: string
  /**
   * The AgenC cloud web origin. Separate from AGENC_AI_AUTHORIZE_URL so
   * attribution redirects do not break links to /code, /settings/connectors,
   * and other web pages.
   */
  AGENC_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  AGENCAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

// Production OAuth configuration - Used in normal operation
//
// IMPORTANT: BASE_API_URL is intentionally an empty string. The donor source
// these moved-source files came from pointed `BASE_API_URL` at
// `https://api.anthropic.com`. AgenC does NOT own that domain, and any
// surviving caller that builds `${BASE_API_URL}/...` while AgenC has no
// hosted backend would silently leak user data to a third party. Empty
// string causes axios/fetch to fail-fast on a malformed URL, so the
// remaining donor callers degrade safely until the deletion sweep finishes
// or AgenC stands up its own backend.
const PROD_OAUTH_CONFIG = {
  BASE_API_URL: '',
  CONSOLE_AUTHORIZE_URL: '',
  AGENC_AI_AUTHORIZE_URL: '',
  AGENC_AI_ORIGIN: '',
  TOKEN_URL: '',
  API_KEY_URL: '',
  ROLES_URL: '',
  CONSOLE_SUCCESS_URL: '',
  AGENCAI_SUCCESS_URL: '',
  MANUAL_REDIRECT_URL: '',
  CLIENT_ID: '',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: '',
  MCP_PROXY_PATH: '',
} as const

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 * When an MCP auth server advertises client_id_metadata_document_supported: true,
 * AgenC uses this URL as its client_id instead of Dynamic Client Registration.
 * The URL must point to a JSON document hosted by provider.
 * See: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
export const MCP_CLIENT_METADATA_URL =
  'https://agenc.tech/oauth/agenc-code-client-metadata'

// Staging OAuth configuration retained as a placeholder shape only. The
// donor URLs were removed alongside the prod config so this never connects
// to an external host while AgenC's hosted backend is unbuilt.
const STAGING_OAUTH_CONFIG = undefined as undefined

// Three local dev servers: :8000 api-proxy (`api dev start -g ccr`),
// :4000 AgenC frontend, :3000 Console frontend. Env vars let
// scripts/agenc-localhost override if your layout differs.
function getLocalOauthConfig(): OauthConfig {
  const api =
    process.env.AGENC_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000'
  const apps =
    process.env.AGENC_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000'
  const consoleBase =
    process.env.AGENC_LOCAL_OAUTH_CONSOLE_BASE?.replace(/\/$/, '') ??
    'http://localhost:3000'
  return {
    BASE_API_URL: api,
    CONSOLE_AUTHORIZE_URL: `${consoleBase}/oauth/authorize`,
    AGENC_AI_AUTHORIZE_URL: `${apps}/oauth/authorize`,
    AGENC_AI_ORIGIN: apps,
    TOKEN_URL: `${api}/v1/oauth/token`,
    API_KEY_URL: `${api}/api/oauth/agenc_cli/create_api_key`,
    ROLES_URL: `${api}/api/oauth/agenc_cli/roles`,
    CONSOLE_SUCCESS_URL: `${consoleBase}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dagenc-code`,
    AGENCAI_SUCCESS_URL: `${consoleBase}/oauth/code/success?app=agenc-code`,
    MANUAL_REDIRECT_URL: `${consoleBase}/oauth/code/callback`,
    CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
    OAUTH_FILE_SUFFIX: '-local-oauth',
    MCP_PROXY_URL: 'http://localhost:8205',
    MCP_PROXY_PATH: '/v1/toolbox/shttp/mcp/{server_id}',
  }
}

// Allowed base URLs for AGENC_CUSTOM_OAUTH_URL override.
// Only FedStart/PubSec deployments are permitted to prevent OAuth tokens
// from being sent to arbitrary endpoints.
const ALLOWED_OAUTH_BASE_URLS = [
  'https://agenc.tech',
]

// Default to prod config, override with test/staging if enabled
export function getOauthConfig(): OauthConfig {
  let config: OauthConfig = (() => {
    switch (getOauthConfigType()) {
      case 'local':
        return getLocalOauthConfig()
      case 'staging':
        return STAGING_OAUTH_CONFIG ?? PROD_OAUTH_CONFIG
      case 'prod':
        return PROD_OAUTH_CONFIG
    }
  })()

  // Allow overriding all OAuth URLs to point to an approved FedStart deployment.
  // Only allowlisted base URLs are accepted to prevent credential leakage.
  const oauthBaseUrl = process.env.AGENC_CUSTOM_OAUTH_URL
  if (oauthBaseUrl) {
    const base = oauthBaseUrl.replace(/\/$/, '')
    if (!ALLOWED_OAUTH_BASE_URLS.includes(base)) {
      throw new Error(
        'AGENC_CUSTOM_OAUTH_URL is not an approved endpoint.',
      )
    }
    config = {
      ...config,
      BASE_API_URL: base,
      CONSOLE_AUTHORIZE_URL: `${base}/oauth/authorize`,
      AGENC_AI_AUTHORIZE_URL: `${base}/oauth/authorize`,
      AGENC_AI_ORIGIN: base,
      TOKEN_URL: `${base}/v1/oauth/token`,
      API_KEY_URL: `${base}/api/oauth/agenc_cli/create_api_key`,
      ROLES_URL: `${base}/api/oauth/agenc_cli/roles`,
      CONSOLE_SUCCESS_URL: `${base}/oauth/code/success?app=agenc-code`,
      AGENCAI_SUCCESS_URL: `${base}/oauth/code/success?app=agenc-code`,
      MANUAL_REDIRECT_URL: `${base}/oauth/code/callback`,
      OAUTH_FILE_SUFFIX: '-custom-oauth',
    }
  }

  // Allow CLIENT_ID override via environment variable (e.g., for Xcode integration)
  const clientIdOverride = process.env.AGENC_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config = {
      ...config,
      CLIENT_ID: clientIdOverride,
    }
  }

  return config
}
