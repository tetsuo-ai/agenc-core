import { afterEach, expect, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
// Define it globally so tests that import modules using MACRO don't crash.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/tetsuo-ai/agenc-core/issues',
  PACKAGE_URL: '@gitlawb/agenc',
  NATIVE_PACKAGE_URL: undefined,
}

import { clearSystemPromptSections } from '../../src/constants/systemPromptSections.ts'
import { getSystemPrompt, DEFAULT_AGENT_PROMPT } from '../../src/constants/prompts.ts'
import { CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } from '../../src/constants/system.ts'
import { requireAgentRole } from '../../src/agents/role.ts'

const originalSimpleEnv = process.env.AGENC_SIMPLE

afterEach(() => {
  process.env.AGENC_SIMPLE = originalSimpleEnv
  clearSystemPromptSections()
})

test('CLI identity prefixes describe AgenC', () => {
  expect(getCLISyspromptPrefix()).toContain('AgenC')
  expect(getCLISyspromptPrefix()).not.toContain("provider's official CLI for AgenC")

  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    expect(prefix).toContain('AgenC')
    expect(prefix).not.toContain("provider's official CLI for AgenC")
  }
})

test('simple mode identity describes AgenC', async () => {
  process.env.AGENC_SIMPLE = '1'

  const prompt = await getSystemPrompt([], 'gpt-4o')

  expect(prompt[0]).toContain('AgenC')
  expect(prompt[0]).not.toContain("provider's official CLI for AgenC")
})

test('system prompt model identity updates when model changes mid-session', async () => {
  delete process.env.AGENC_SIMPLE
  clearSystemPromptSections()

  const firstPrompt = await getSystemPrompt([], 'old-test-model')
  const secondPrompt = await getSystemPrompt([], 'new-test-model')

  const firstText = firstPrompt.join('\n')
  const secondText = secondPrompt.join('\n')

  expect(firstText).toContain('You are powered by the model old-test-model.')
  expect(secondText).toContain('You are powered by the model new-test-model.')
  expect(secondText).not.toContain('You are powered by the model old-test-model.')
})

test('built-in agent prompts describe AgenC', () => {
  expect(DEFAULT_AGENT_PROMPT).toContain('AgenC')
  expect(DEFAULT_AGENT_PROMPT).not.toContain("provider's official CLI for AgenC")

  // The built-in agents are now first-class roles; their prompts live on the
  // role config. Resolve via aliases to also assert alias→role wiring.
  // (The default/general-purpose role intentionally carries no system prompt.)
  const explorePrompt = requireAgentRole('scanner').config.systemPrompt ?? ''
  expect(explorePrompt).toContain('AgenC')
  expect(explorePrompt).not.toContain("provider's official CLI for AgenC")

  const planPrompt = requireAgentRole('Plan').config.systemPrompt ?? ''
  expect(planPrompt).toContain('AgenC')
  expect(planPrompt).not.toContain("provider's official CLI for AgenC")

  // The verification prompt does not use the "for AgenC" domain phrasing, but it
  // must still be free of stray upstream branding.
  const verificationPrompt = requireAgentRole('verification').config.systemPrompt ?? ''
  expect(verificationPrompt).not.toContain("provider's official CLI for AgenC")
})
