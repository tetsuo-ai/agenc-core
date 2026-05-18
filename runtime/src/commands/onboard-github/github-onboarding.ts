import {
  hydrateGithubModelsTokenFromSecureStorage,
  readGithubModelsToken,
} from '../../utils/githubModelsCredentials.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'

const DEFAULT_MODEL = 'github:copilot'
const FORCE_RELOGIN_ARGS = new Set([
  'force',
  '--force',
  'relogin',
  '--relogin',
  'reauth',
  '--reauth',
])

const PROVIDER_SPECIFIC_KEYS = new Set([
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_AUTH_MODE',
])

export function shouldForceGithubRelogin(args?: string): boolean {
  const normalized = (args ?? '').trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized.split(/\s+/).some(arg => FORCE_RELOGIN_ARGS.has(arg))
}

const GITHUB_PAT_PREFIXES = ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_']

function isGithubPat(token: string): boolean {
  return GITHUB_PAT_PREFIXES.some(prefix => token.startsWith(prefix))
}

export function hasExistingGithubModelsLoginToken(
  env: NodeJS.ProcessEnv = process.env,
  storedToken?: string,
): boolean {
  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (envToken) {
    if (isGithubPat(envToken)) {
      return false
    }
    return true
  }
  const persisted = (storedToken ?? readGithubModelsToken())?.trim()
  if (persisted && isGithubPat(persisted)) {
    return false
  }
  return Boolean(persisted)
}

export function buildGithubOnboardingSettingsEnv(
  model: string,
): Record<string, string | undefined> {
  return {
    AGENC_USE_GITHUB: '1',
    OPENAI_MODEL: model,
    OPENAI_API_KEY: undefined,
    OPENAI_ORG: undefined,
    OPENAI_PROJECT: undefined,
    OPENAI_ORGANIZATION: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
    AGENC_USE_OPENAI: undefined,
    AGENC_USE_GEMINI: undefined,
    AGENC_USE_BEDROCK: undefined,
    AGENC_USE_VERTEX: undefined,
    AGENC_USE_FOUNDRY: undefined,
  }
}

export function applyGithubOnboardingProcessEnv(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.AGENC_USE_GITHUB = '1'
  env.OPENAI_MODEL = model

  delete env.OPENAI_API_KEY
  delete env.OPENAI_ORG
  delete env.OPENAI_PROJECT
  delete env.OPENAI_ORGANIZATION
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_API_BASE

  delete env.AGENC_USE_OPENAI
  delete env.AGENC_USE_GEMINI
  delete env.AGENC_USE_BEDROCK
  delete env.AGENC_USE_VERTEX
  delete env.AGENC_USE_FOUNDRY
  delete env.AGENC_PROVIDER_PROFILE_ENV_APPLIED
  delete env.AGENC_PROVIDER_PROFILE_ENV_APPLIED_ID
}

function mergeUserSettingsEnv(model: string): { ok: boolean; detail?: string } {
  const currentSettings = getSettingsForSource('userSettings')
  const currentEnv = currentSettings?.env ?? {}

  const newEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(currentEnv)) {
    if (!PROVIDER_SPECIFIC_KEYS.has(key)) {
      newEnv[key] = value
    }
  }

  newEnv.AGENC_USE_GITHUB = '1'
  newEnv.OPENAI_MODEL = model

  const { error } = updateSettingsForSource('userSettings', {
    env: newEnv,
  })
  if (error) {
    return { ok: false, detail: error.message }
  }
  return { ok: true }
}

export function activateGithubOnboardingMode(
  model: string = DEFAULT_MODEL,
  options?: {
    mergeSettingsEnv?: (model: string) => { ok: boolean; detail?: string }
    applyProcessEnv?: (model: string) => void
    hydrateToken?: () => void
    onChangeAPIKey?: () => void
  },
): { ok: boolean; detail?: string } {
  const normalizedModel = model.trim() || DEFAULT_MODEL
  const mergeSettingsEnv = options?.mergeSettingsEnv ?? mergeUserSettingsEnv
  const applyProcessEnv = options?.applyProcessEnv ?? applyGithubOnboardingProcessEnv
  const hydrateToken =
    options?.hydrateToken ?? hydrateGithubModelsTokenFromSecureStorage

  const merged = mergeSettingsEnv(normalizedModel)
  if (!merged.ok) {
    return merged
  }

  applyProcessEnv(normalizedModel)
  hydrateToken()
  options?.onChangeAPIKey?.()
  return { ok: true }
}
