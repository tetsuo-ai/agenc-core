/**
 * AgenC startup screen — filled-block text logo with theme-owned ANSI colors.
 * Called once at CLI startup before the Ink UI renders.
 *
 * Addresses: issue #55
 */

import { isLocalProviderUrl, resolveProviderRequest } from '../../services/api/providerConfig.js'
import { getLocalOpenAICompatibleProviderLabel } from '../../utils/providerDiscovery.js' // branding-scan: allow real provider helper name
import { getInitialSettings } from '../../utils/settings/settings.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { containsExactZaiGlmModelId, isZaiBaseUrl } from '../../utils/zaiProvider.js'
import { getTheme, themeColorToAnsi, type Theme } from '../../utils/theme.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`

const STARTUP_THEME = getTheme('dark')

type StartupColor = keyof Pick<
  Theme,
  | 'agenc'
  | 'briefLabelWorker'
  | 'success'
  | 'error'
  | 'inactive'
  | 'text2'
  | 'line'
  | 'worker'
>

function ansi(color: StartupColor): string {
  return themeColorToAnsi(STARTUP_THEME[color])
}

function paintLine(text: string, color: StartupColor): string {
  return `${ansi(color)}${text}${RESET}`
}

// ─── Filled Block Text Logo ───────────────────────────────────────────────────

const LOGO_AGENC = [
  `  \u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 `,
  ` \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d `,
  ` \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551      `,
  ` \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551 \u2588\u2588\u2554\u2550\u2550\u255d  \u2588\u2588\u2551\u255a\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551      `,
  ` \u2588\u2588\u2551  \u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551 \u255a\u2588\u2588\u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557 `,
  ` \u255a\u2550\u255d  \u255a\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d `,
]

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean } {
  const useGemini = process.env.AGENC_USE_GEMINI === '1' || process.env.AGENC_USE_GEMINI === 'true'
  const useGithub = process.env.AGENC_USE_GITHUB === '1' || process.env.AGENC_USE_GITHUB === 'true'
  const useOpenAi = process.env.AGENC_USE_OPENAI === '1' || process.env.AGENC_USE_OPENAI === 'true'
  const useMistral = process.env.AGENC_USE_MISTRAL === '1' || process.env.AGENC_USE_MISTRAL === 'true'

  if (useGemini) {
    const model = modelOverride || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'
    return { name: 'Google Gemini', model, baseUrl, isLocal: false }
  }

  if (useMistral) {
    const model = modelOverride || process.env.MISTRAL_MODEL || 'devstral-latest'
    const baseUrl = process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1'
    return { name: 'Mistral', model, baseUrl, isLocal: false }
  }

  if (useGithub) {
    const model = modelOverride || process.env.OPENAI_MODEL || 'github:copilot'
    const baseUrl =
      process.env.OPENAI_BASE_URL || 'https://api.githubcopilot.com'
    return { name: 'GitHub Copilot', model, baseUrl, isLocal: false }
  }

  if (useOpenAi) {
    const rawModel = modelOverride || process.env.OPENAI_MODEL || 'gpt-4o'
    const resolvedRequest = resolveProviderRequest({
      model: rawModel,
      baseUrl: process.env.OPENAI_BASE_URL,
    })
    const baseUrl = resolvedRequest.baseUrl
    const isLocal = isLocalProviderUrl(baseUrl)
    let name = 'OpenAI' // branding-scan: allow real provider display name
    // Explicit dedicated-provider env flags win.
    if (process.env.NVIDIA_NIM) name = 'NVIDIA NIM'
    else if (process.env.MINIMAX_API_KEY) name = 'MiniMax'
    else if (
      resolvedRequest.transport === 'providerCode_responses' || // branding-scan: allow provider transport literal
      baseUrl.includes('chatgpt.com/backend-api/providerCode') // branding-scan: allow provider endpoint path
    )
      name = 'OpenAI Responses' // branding-scan: allow real provider display name
    // Base URL is authoritative — must precede rawModel checks so aggregators
    // (OpenRouter/Together/Groq) aren't mislabelled as DeepSeek/Kimi/etc.
    // when routed to models whose IDs contain a vendor prefix. See issue #855.
    else if (/openrouter/i.test(baseUrl)) name = 'OpenRouter'
    else if (/together/i.test(baseUrl)) name = 'Together AI'
    else if (/groq/i.test(baseUrl)) name = 'Groq'
    else if (/azure/i.test(baseUrl)) name = 'Azure OpenAI' // branding-scan: allow real provider display name
    else if (/nvidia/i.test(baseUrl)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(baseUrl)) name = 'MiniMax'
    else if (/api\.kimi\.com/i.test(baseUrl)) name = 'Moonshot AI - Kimi Code'
    else if (/moonshot/i.test(baseUrl)) name = 'Moonshot AI - API'
    else if (/deepseek/i.test(baseUrl)) name = 'DeepSeek'
    else if (/x\.ai/i.test(baseUrl)) name = 'xAI'
    else if (isZaiBaseUrl(baseUrl)) name = 'Z.AI - GLM'
    else if (/mistral/i.test(baseUrl)) name = 'Mistral'
    // rawModel fallback — fires only when base URL is generic/custom.
    else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(rawModel)) name = 'MiniMax'
    else if (/\bkimi-for-coding\b/i.test(rawModel))
      name = 'Moonshot AI - Kimi Code'
    else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
      name = 'Moonshot AI - API'
    else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
    else if (/grok/i.test(rawModel)) name = 'xAI'
    else if (containsExactZaiGlmModelId(rawModel)) name = 'Z.AI - GLM'
    else if (/mistral/i.test(rawModel)) name = 'Mistral'
    else if (/llama/i.test(rawModel)) name = 'Meta Llama'
    else if (/bankr/i.test(baseUrl)) name = 'Bankr'
    else if (/bankr/i.test(rawModel)) name = 'Bankr'
    else if (isLocal) name = getLocalOpenAICompatibleProviderLabel(baseUrl) // branding-scan: allow real provider helper name
    
    // Resolve model alias to actual model name + reasoning effort
    let displayModel = resolvedRequest.resolvedModel
    if (resolvedRequest.reasoning?.effort) {
      displayModel = `${displayModel} (${resolvedRequest.reasoning.effort})`
    }
    
    return { name, model: displayModel, baseUrl, isLocal }
  }

  // Default: provider - check settings.model first, then env vars
  const settings = getInitialSettings() || {}
  const modelSetting = modelOverride || settings.model || process.env.ANTHROPIC_MODEL || process.env.AGENC_MODEL || 'claude-sonnet-4-6'
  const resolvedModel = parseUserSpecifiedModel(modelSetting)
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  const isLocal = isLocalProviderUrl(baseUrl)
  return { name: 'Anthropic', model: resolvedModel, baseUrl, isLocal } // branding-scan: allow real provider display name
}

// ─── Box drawing ──────────────────────────────────────────────────────────────

function boxRow(content: string, width: number, rawLen: number): string {
  const pad = Math.max(0, width - 2 - rawLen)
  return `${ansi('line')}\u2502${RESET}${content}${' '.repeat(pad)}${ansi('line')}\u2502${RESET}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function printStartupScreen(modelOverride?: string): void {
  // Skip in non-interactive / CI / print mode
  if (process.env.CI || !process.stdout.isTTY) return

  const p = detectProvider(modelOverride)
  const W = 62
  const out: string[] = []

  out.push('')
  out.push(`${ansi('error')}●${RESET} ${ansi('worker')}●${RESET} ${ansi('success')}●${RESET} ${DIM}${ansi('inactive')} agenc - orchestrator${RESET}`)
  out.push(`${ansi('line')}${'─'.repeat(W)}${RESET}`)
  out.push('')

  const allLogo = LOGO_AGENC
  const logoColors: readonly StartupColor[] = [
    'agenc',
    'worker',
    'briefLabelWorker',
  ]
  for (let i = 0; i < allLogo.length; i++) {
    if (allLogo[i] === '') {
      out.push('')
    } else {
      out.push(paintLine(allLogo[i], logoColors[i % logoColors.length]!))
    }
  }

  out.push('')

  // Tagline
  out.push(`  ${ansi('agenc')}\u2726${RESET} ${ansi('text2')}Orchestrator online. Multi-agent terminal ready.${RESET} ${ansi('agenc')}\u2726${RESET}`)
  out.push('')

  // Provider info box
  out.push(`${ansi('line')}\u2554${'\u2550'.repeat(W - 2)}\u2557${RESET}`)

  const lbl = (k: string, v: string, c: StartupColor = 'text2'): [string, number] => {
    const padK = k.padEnd(9)
    return [` ${DIM}${ansi('inactive')}${padK}${RESET} ${ansi(c)}${v}${RESET}`, ` ${padK} ${v}`.length]
  }

  const provC: StartupColor = p.isLocal ? 'success' : 'agenc'
  let [r, l] = lbl('Provider', p.name, provC)
  out.push(boxRow(r, W, l))
  ;[r, l] = lbl('Model', p.model)
  out.push(boxRow(r, W, l))
  const ep = p.baseUrl.length > 38 ? p.baseUrl.slice(0, 35) + '...' : p.baseUrl
  ;[r, l] = lbl('Endpoint', ep)
  out.push(boxRow(r, W, l))

  out.push(`${ansi('line')}\u2560${'\u2550'.repeat(W - 2)}\u2563${RESET}`)

  const sC: StartupColor = p.isLocal ? 'success' : 'agenc'
  const sL = p.isLocal ? 'local' : 'cloud'
  const sRow = ` ${ansi(sC)}\u25cf${RESET} ${DIM}${ansi('inactive')}${sL}${RESET}    ${DIM}${ansi('inactive')}Ready :: type ${RESET}${ansi('agenc')}/help${RESET}${DIM}${ansi('inactive')} to begin${RESET}`
  const sLen = ` \u25cf ${sL}    Ready :: type /help to begin`.length
  out.push(boxRow(sRow, W, sLen))

  out.push(`${ansi('line')}\u255a${'\u2550'.repeat(W - 2)}\u255d${RESET}`)
  out.push(`  ${DIM}${ansi('inactive')}agenc ${RESET}${ansi('agenc')}v${MACRO.DISPLAY_VERSION ?? MACRO.VERSION}${RESET}`)
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
