/**
 * Security hardening regression tests.
 *
 * Covers:
 * 1. MCP tool result Unicode sanitization
 * 2. Sandbox settings source filtering (exclude projectSettings)
 * 3. Plugin git clone/pull hooks disabled
 * 4. ANTHROPIC_FOUNDRY_API_KEY removed from SAFE_ENV_VARS
 * 5. WebFetch SSRF protection via ssrfGuardedLookup
 */

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'

const SRC = resolve(import.meta.dir, '..', '..', '..', 'src')
const file = (relative: string) => Bun.file(resolve(SRC, relative))

// ---------------------------------------------------------------------------
// Fix 1: MCP tool result Unicode sanitization
// ---------------------------------------------------------------------------
describe('MCP tool result sanitization', () => {
  test('transformResultContent sanitizes text content', async () => {
    const content = await file('services/mcp/client.ts').text()
    // Tool definitions are already sanitized (line ~1798)
    expect(content).toContain('recursivelySanitizeUnicode(result.tools)')
    // Tool results must also be sanitized
    expect(content).toMatch(
      /case 'text':[\s\S]*?recursivelySanitizeUnicode\(resultContent\.text\)/,
    )
  })

  test('resource text content is also sanitized', async () => {
    const content = await file('services/mcp/client.ts').text()
    expect(content).toMatch(
      /recursivelySanitizeUnicode\(\s*`\$\{prefix\}\$\{resource\.text\}`/,
    )
  })
})

// ---------------------------------------------------------------------------
// Fix 2: Sandbox settings source filtering
// ---------------------------------------------------------------------------
describe('Sandbox settings trust boundary', () => {
  test('getSandboxEnabledSetting reads only trusted canonical sources', async () => {
    const content = await file('utils/sandbox/sandbox-runtime.ts').text()
    // Extract the getSandboxEnabledSetting function body
    const fnMatch = content.match(
      /function getSandboxEnabledSetting\(\)[^{]*\{([\s\S]*?)\n\}/,
    )
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch![1]
    // Must use getSettingsForSource for individual trusted sources
    expect(fnBody).toContain("getSettingsForSource('userSettings')")
    expect(fnBody).toContain("getSettingsForSource('policySettings')")
    // Must NOT read from projectSettings
    expect(fnBody).not.toContain("'projectSettings'")
  })
})

// ---------------------------------------------------------------------------
// Fix 3: Plugin git hooks disabled
// ---------------------------------------------------------------------------
describe('Plugin git operations disable hooks', () => {
  test('the canonical marketplace acquisition path disables git hooks', async () => {
    const content = await file('plugins/marketplace/marketplace.ts').text()
    expect(content).toContain('const GIT_NO_HOOKS_ARGS = ["-c", "core.hooksPath=/dev/null"]')
    expect(content).not.toContain('utils/plugins/marketplaceManager')
  })
})

// ---------------------------------------------------------------------------
// Fix 4: ANTHROPIC_FOUNDRY_API_KEY not in SAFE_ENV_VARS
// ---------------------------------------------------------------------------
describe('SAFE_ENV_VARS excludes credentials', () => {
  test('ANTHROPIC_FOUNDRY_API_KEY is not in SAFE_ENV_VARS', async () => {
    const content = await file('utils/managedEnvConstants.ts').text()
    // Extract the SAFE_ENV_VARS set definition
    const safeStart = content.indexOf('export const SAFE_ENV_VARS')
    const safeEnd = content.indexOf('])', safeStart)
    const safeSection = content.slice(safeStart, safeEnd)
    expect(safeSection).not.toContain('ANTHROPIC_FOUNDRY_API_KEY')
  })
})

// ---------------------------------------------------------------------------
// Fix 5: WebFetch SSRF protection
// ---------------------------------------------------------------------------
describe('WebFetch SSRF guard', () => {
  test('getWithPermittedRedirects uses ssrfGuardedLookup', async () => {
    const content = await file('tools/WebFetchTool/utils.ts').text()
    expect(content).toContain(
      "import { ssrfGuardedLookup } from '../../utils/hooks/ssrfGuard.js'",
    )
    // The axios.get call in getWithPermittedRedirects must include lookup
    const fnSection = content.slice(
      content.indexOf('export async function getWithPermittedRedirects('),
      content.indexOf('export async function getWithPermittedRedirects(') +
        1000,
    )
    expect(fnSection).toContain('lookup: ssrfGuardedLookup')
  })
})
