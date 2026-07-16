import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { createAgentRoleWorkspace } from '../../../agents/role.js'
import { runWithCwdOverride } from '../../../utils/cwd.js'
import {
  deleteAgentFromFile,
  formatAgentAsMarkdown,
  getActualAgentFilePath,
  getActualRelativeAgentFilePath,
  getNewAgentFilePath,
  getNewRelativeAgentFilePath,
  saveAgentToFile,
  updateAgentFile,
} from './agentFileUtils.js'

describe('agent file utilities wave 200 coverage', () => {
  test('formats options and handles custom agent file lifecycle paths', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-agent-file-utils-'))
    const roleWorkspace = createAgentRoleWorkspace(cwd)
    const authority = { roleWorkspace, catalogWorkspaceId: roleWorkspace.id }

    try {
      await runWithCwdOverride(cwd, async () => {
        const formatted = formatAgentAsMarkdown(
          'triage-helper',
          'Use "quotes"\nwith a backslash \\ marker',
          ['Read', 'Edit'],
          'Prefer concise findings.',
          'green',
          'agenc-balanced',
          'project',
          'high',
        )

        const descriptionLine = formatted
          .split('\n')
          .find((line) => line.startsWith('description: '))
        expect(descriptionLine).toBe(
          'description: "Use \\"quotes\\"\\\\nwith a backslash \\\\ marker"',
        )
        expect(formatted).toContain('\ntools: Read, Edit')
        expect(formatted).toContain('\nmodel: agenc-balanced')
        expect(formatted).toContain('\neffort: high')
        expect(formatted).toContain('\ncolor: green')
        expect(formatted).toContain('\nmemory: project')

        const newAgentPath = join(
          cwd,
          '.agenc',
          'agents',
          'triage-helper.md',
        )
        expect(
          getNewAgentFilePath({
            source: 'projectSettings',
            agentType: 'triage-helper',
          }, cwd),
        ).toBe(newAgentPath)
        expect(
          getNewRelativeAgentFilePath({
            source: 'projectSettings',
            agentType: 'triage-helper',
          }),
        ).toBe(join('.agenc', 'agents', 'triage-helper.md'))
        expect(
          getNewRelativeAgentFilePath({
            source: 'built-in',
            agentType: 'built-in-helper',
          }),
        ).toBe('Built-in')
        expect(() =>
          getNewAgentFilePath({
            source: 'flagSettings',
            agentType: 'cli-helper',
          }, cwd),
        ).toThrow('Cannot get directory path for flagSettings agents')

        const agentDir = join(cwd, '.agenc', 'agents')
        mkdirSync(agentDir, { recursive: true })
        const storedAgentPath = join(agentDir, 'stored-helper.md')
        writeFileSync(storedAgentPath, 'old content', 'utf8')

        const customAgent: AgentDefinition = {
          agentType: 'triage-helper',
          whenToUse: 'Use for triage.',
          source: 'projectSettings',
          filename: 'stored-helper',
          getSystemPrompt: () => 'old content',
        }
        expect(getActualAgentFilePath(customAgent, cwd)).toBe(storedAgentPath)
        expect(getActualRelativeAgentFilePath(customAgent)).toBe(
          join('.agenc', 'agents', 'stored-helper.md'),
        )

        const builtInAgent: AgentDefinition = {
          agentType: 'built-in-helper',
          whenToUse: 'Use built-in behavior.',
          source: 'built-in',
          baseDir: 'built-in',
          getSystemPrompt: () => 'built-in prompt',
        }
        expect(getActualAgentFilePath(builtInAgent, cwd)).toBe('Built-in')
        expect(getActualRelativeAgentFilePath(builtInAgent)).toBe('Built-in')

        const pluginAgent: AgentDefinition = {
          agentType: 'plugin-helper',
          whenToUse: 'Use plugin behavior.',
          source: 'plugin',
          plugin: '',
          getSystemPrompt: () => 'plugin prompt',
        }
        expect(() => getActualAgentFilePath(pluginAgent, cwd)).toThrow(
          'Cannot get file path for plugin agents',
        )
        expect(getActualRelativeAgentFilePath(pluginAgent)).toBe(
          'Plugin: Unknown',
        )

        await updateAgentFile(
          authority,
          customAgent,
          'Use after update.',
          ['Search'],
          'Updated system prompt.',
          'blue',
          'agenc-deep',
          'local',
          3,
        )
        const updated = readFileSync(storedAgentPath, 'utf8')
        expect(updated).toContain('name: triage-helper')
        expect(updated).toContain('tools: Search')
        expect(updated).toContain('model: agenc-deep')
        expect(updated).toContain('effort: 3')
        expect(updated).toContain('memory: local')

        await saveAgentToFile(
          authority,
          'projectSettings',
          'triage-helper',
          'Use for duplicate checks.',
          ['*'],
          'Initial system prompt.',
          false,
        )
        expect(readFileSync(newAgentPath, 'utf8')).not.toContain('\ntools:')
        await expect(
          saveAgentToFile(
            authority,
            'projectSettings',
            'triage-helper',
            'Use for duplicate checks.',
            ['*'],
            'Initial system prompt.',
          ),
        ).rejects.toThrow(`Agent file already exists: ${newAgentPath}`)

        await deleteAgentFromFile(authority, customAgent)
        expect(existsSync(storedAgentPath)).toBe(false)
        await expect(
          deleteAgentFromFile(authority, customAgent),
        ).resolves.toBeUndefined()
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
