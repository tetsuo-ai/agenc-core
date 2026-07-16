import { describe, expect, it } from 'vitest'

import type { TeammateIdentity } from '../../../src/tasks/InProcessTeammateTask/types.js'
import type { AgentDefinition } from '../../../src/tools/AgentTool/loadAgentsDir.js'
import { resolveInProcessAgentDefinition } from '../../../src/utils/swarm/inProcessRolePolicy.js'

const identity: TeammateIdentity = {
  agentId: 'scanner@team',
  agentName: 'scanner',
  teamName: 'team',
  planModeRequired: false,
  parentSessionId: 'parent',
}

describe('in-process teammate role policy', () => {
  it('preserves a restrictive built-in allowlist, denylist, and permission mode', () => {
    const selected: AgentDefinition = {
      agentType: 'scanner',
      whenToUse: 'Read-only scanner',
      source: 'built-in',
      baseDir: 'built-in',
      tools: ['Read'],
      disallowedTools: ['Write'],
      permissionMode: 'plan',
      getSystemPrompt: () => 'Inspect without mutation.',
    }

    const resolved = resolveInProcessAgentDefinition({
      identity,
      teammateSystemPrompt: 'Teammate scanner prompt',
      agentDefinition: selected,
    })
    expect(resolved).toMatchObject({
      agentType: 'scanner',
      source: 'built-in',
      disallowedTools: ['Write'],
      permissionMode: 'plan',
    })
    expect(resolved.tools).not.toContain('*')
    expect(resolved.tools).toContain('Read')
    expect(resolved.disallowedTools).toContain('Write')
  })

  it('lets mandatory plan mode override a weaker definition mode', () => {
    const resolved = resolveInProcessAgentDefinition({
      identity: { ...identity, planModeRequired: true },
      teammateSystemPrompt: 'Plan first.',
      agentDefinition: {
        agentType: 'worker',
        whenToUse: 'Worker',
        source: 'projectSettings',
        permissionMode: 'acceptEdits',
        getSystemPrompt: () => 'Work.',
      },
    })
    expect(resolved.permissionMode).toBe('plan')
  })
})
