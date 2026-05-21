import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AgentDefinition } from '../../../src/tools/AgentTool/loadAgentsDir.js'
import { runWithCwdOverride } from '../../../src/utils/cwd.js'
import {
  deleteAgentFromFile,
  getActualAgentFilePath,
  getActualRelativeAgentFilePath,
  getNewAgentFilePath,
  getNewRelativeAgentFilePath,
  saveAgentToFile,
  updateAgentFile,
} from '../../../src/tui/components/agents/agentFileUtils.js'

function customAgent(
  agentType: string,
  source: 'userSettings' | 'projectSettings' | 'policySettings' | 'flagSettings',
  filename?: string,
): AgentDefinition {
  return {
    agentType,
    whenToUse: 'Use for focused coverage.',
    source,
    filename,
    getSystemPrompt: () => 'Follow the instructions.',
  }
}

describe('agentFileUtils coverage swarm row 108', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('resolves user, policy, local, and flag agent paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-agent-paths-'))
    const configHome = join(cwd, 'config-home')
    const managedHome = join(cwd, 'managed-home')

    vi.stubEnv('AGENC_CONFIG_DIR', configHome)
    vi.stubEnv('USER_TYPE', 'ant')
    vi.stubEnv('AGENC_MANAGED_SETTINGS_PATH', managedHome)

    try {
      await runWithCwdOverride(cwd, async () => {
        expect(
          getNewAgentFilePath({
            source: 'userSettings',
            agentType: 'user-helper',
          }),
        ).toBe(join(configHome, 'agents', 'user-helper.md'))
        expect(
          getNewRelativeAgentFilePath({
            source: 'userSettings',
            agentType: 'user-helper',
          }),
        ).toBe(join(configHome, 'agents', 'user-helper.md'))

        expect(
          getNewAgentFilePath({
            source: 'policySettings',
            agentType: 'managed-helper',
          }),
        ).toBe(join(managedHome, '.agenc', 'agents', 'managed-helper.md'))
        expect(
          getNewRelativeAgentFilePath({
            source: 'policySettings',
            agentType: 'managed-helper',
          }),
        ).toBe(join(managedHome, '.agenc', 'agents', 'managed-helper.md'))

        expect(
          getNewAgentFilePath({
            source: 'localSettings',
            agentType: 'local-helper',
          }),
        ).toBe(join(cwd, '.agenc', 'agents', 'local-helper.md'))
        expect(
          getNewRelativeAgentFilePath({
            source: 'localSettings',
            agentType: 'local-helper',
          }),
        ).toBe(join(cwd, '.agenc', 'agents', 'local-helper.md'))

        expect(getActualAgentFilePath(customAgent('user-helper', 'userSettings'))).toBe(
          join(configHome, 'agents', 'user-helper.md'),
        )
        expect(
          getActualRelativeAgentFilePath(
            customAgent('renamed-helper', 'projectSettings', 'stored-helper'),
          ),
        ).toBe(join('.agenc', 'agents', 'stored-helper.md'))
        expect(
          getActualRelativeAgentFilePath(customAgent('cli-helper', 'flagSettings')),
        ).toBe('CLI argument')
        expect(
          getActualRelativeAgentFilePath({
            agentType: 'plugin-helper',
            whenToUse: 'Use plugin behavior.',
            source: 'plugin',
            plugin: 'quality-plugin',
            getSystemPrompt: () => 'Plugin prompt.',
          }),
        ).toBe('Plugin: quality-plugin')
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('saves user agents and preserves non-existence write errors', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-agent-save-'))
    const configHome = join(cwd, 'config-home')

    vi.stubEnv('AGENC_CONFIG_DIR', configHome)

    try {
      await saveAgentToFile(
        'userSettings',
        'user-helper',
        'Use this helper for user-wide work.',
        ['Read'],
        'Stay focused.',
      )

      const userFile = join(configHome, 'agents', 'user-helper.md')
      expect(readFileSync(userFile, 'utf8')).toContain('tools: Read')

      await runWithCwdOverride(cwd, async () => {
        await expect(
          saveAgentToFile(
            'projectSettings',
            'missing-dir/nested-helper',
            'Use this helper when a nested path is requested.',
            ['Read'],
            'This write should fail before content is created.',
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('rejects built-in mutations and rethrows delete failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-agent-errors-'))
    const builtInAgent: AgentDefinition = {
      agentType: 'built-in-helper',
      whenToUse: 'Use built-in behavior.',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'Built-in prompt.',
    }

    try {
      await expect(
        saveAgentToFile(
          'built-in',
          'built-in-helper',
          'Use built-in behavior.',
          undefined,
          'Built-in prompt.',
        ),
      ).rejects.toThrow('Cannot save built-in agents')
      await expect(
        updateAgentFile(
          builtInAgent,
          'Use built-in behavior.',
          undefined,
          'Built-in prompt.',
        ),
      ).rejects.toThrow('Cannot update built-in agents')
      await expect(deleteAgentFromFile(builtInAgent)).rejects.toThrow(
        'Cannot delete built-in agents',
      )

      await runWithCwdOverride(cwd, async () => {
        const agentDir = join(cwd, '.agenc', 'agents')
        mkdirSync(join(agentDir, 'blocked-helper.md'), { recursive: true })

        await expect(
          deleteAgentFromFile(
            customAgent('blocked-helper', 'projectSettings'),
          ),
        ).rejects.toMatchObject({ code: 'EISDIR' })
        expect(existsSync(join(agentDir, 'blocked-helper.md'))).toBe(true)
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
