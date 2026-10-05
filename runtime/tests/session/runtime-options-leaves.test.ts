import { expect, it } from 'vitest'
import * as canonical from '../../src/session/runtime-options.js'
import * as ingress from '../../src/session/runtime-options-ingress.js'
import * as context from '../../src/session/runtime-options-context.js'

it('preserves error, validator, constant and scope identities at the compatibility path', () => {
  expect(canonical.AgentRuntimeOptionsError).toBe(ingress.AgentRuntimeOptionsError)
  expect(canonical.assertNoRetiredAgentRuntimeEnvironment).toBe(ingress.assertNoRetiredAgentRuntimeEnvironment)
  expect(canonical.RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS).toBe(ingress.RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS)
  expect(canonical.peekAgentRuntimeOptions).toBe(context.peekAgentRuntimeOptions)
  expect(canonical.runWithAgentRuntimeOptions).toBe(context.runWithAgentRuntimeOptions)
})

it('keeps both import paths on one isolated async option scope', async () => {
  // This fixture needs only scope storage: no directories or session are created.
  const run = async (simpleMode: boolean) => {
    const value = Object.freeze({ simpleMode }) as canonical.AgentRuntimeOptions
    await canonical.runWithAgentRuntimeOptions(value, async () => {
      await Promise.resolve()
      expect(context.peekAgentRuntimeOptions()).toBe(value)
      expect(canonical.peekAgentRuntimeOptions()).toBe(value)
      context.runWithAgentRuntimeOptions({ ...value, simpleMode: !simpleMode }, () => {
        expect(canonical.peekAgentRuntimeOptions()?.simpleMode).toBe(!simpleMode)
      })
      expect(context.peekAgentRuntimeOptions()).toBe(value)
    })
  }
  await Promise.all([run(true), run(false)])
  expect(canonical.peekAgentRuntimeOptions()).toBeUndefined()
})
