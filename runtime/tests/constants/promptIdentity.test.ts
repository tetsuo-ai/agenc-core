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
import { AGENC_GUIDE_AGENT } from '../../src/tools/AgentTool/built-in/agencGuideAgent.ts'
import { GENERAL_PURPOSE_AGENT } from '../../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
import { EXPLORE_AGENT } from '../../src/tools/AgentTool/built-in/exploreAgent.ts'
import { PLAN_AGENT } from '../../src/tools/AgentTool/built-in/planAgent.ts'
import { STATUSLINE_SETUP_AGENT } from '../../src/tools/AgentTool/built-in/statuslineSetup.ts'

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

  const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(generalPrompt).toContain('AgenC')
  expect(generalPrompt).not.toContain("provider's official CLI for AgenC")

  const explorePrompt = EXPLORE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(explorePrompt).toContain('AgenC')
  expect(explorePrompt).not.toContain("provider's official CLI for AgenC")

  const planPrompt = PLAN_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(planPrompt).toContain('AgenC')

  const statuslinePrompt = STATUSLINE_SETUP_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(statuslinePrompt).toContain('AgenC')

  const guidePrompt = AGENC_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
      } as never,
    },
  })
  expect(guidePrompt).toContain('AgenC')
  expect(guidePrompt).toContain('You are the AgenC guide agent.')
  expect(guidePrompt).toContain('**AgenC** (the CLI tool)')
})
