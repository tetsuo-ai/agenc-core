import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { runWithCwdOverride } from '../../../utils/cwd.js'
import {
  __setAgentFileOperationHookForTesting,
  deleteAgentFromFile,
  saveAgentToFile,
  updateAgentFile,
} from './agentFileUtils.js'
import { createAgentRoleWorkspace } from '../../../agents/role.js'

describe('agent file creation', () => {
  test('writes generated project agents to .agenc/agents', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-generated-agent-'))
    const roleWorkspace = createAgentRoleWorkspace(cwd)
    try {
      await runWithCwdOverride(cwd, async () => {
        await saveAgentToFile(
          { roleWorkspace, catalogWorkspaceId: roleWorkspace.id },
          'projectSettings',
          'python-game-reviewer',
          'Use this agent when reviewing the Python guessing game.',
          undefined,
          'You are a focused Python game reviewer.',
        )
      })

      const filePath = join(cwd, '.agenc', 'agents', 'python-game-reviewer.md')
      expect(readFileSync(filePath, 'utf8')).toContain(
        'name: python-game-reviewer',
      )
      expect(readFileSync(filePath, 'utf8')).toContain(
        'You are a focused Python game reviewer.',
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('rejects a foreign catalog before create, update, or delete mutation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-authority-'))
    const foreignRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-foreign-'))
    const roleWorkspace = createAgentRoleWorkspace(workspaceRoot)
    const foreignWorkspace = createAgentRoleWorkspace(foreignRoot)
    const authority = {
      roleWorkspace,
      catalogWorkspaceId: foreignWorkspace.id,
    }
    const filePath = join(workspaceRoot, '.agenc', 'agents', 'guarded.md')
    const definition = {
      agentType: 'guarded',
      whenToUse: 'Guarded',
      source: 'projectSettings' as const,
      getSystemPrompt: () => 'Original',
    }
    try {
      await expect(
        saveAgentToFile(
          authority,
          'projectSettings',
          'guarded',
          'Guarded',
          undefined,
          'Created',
        ),
      ).rejects.toThrow('agent role workspace mismatch')
      expect(existsSync(filePath)).toBe(false)

      mkdirSync(join(workspaceRoot, '.agenc', 'agents'), { recursive: true })
      writeFileSync(filePath, 'original', 'utf8')
      await expect(
        updateAgentFile(authority, definition, 'Changed', [], 'Changed'),
      ).rejects.toThrow('agent role workspace mismatch')
      expect(readFileSync(filePath, 'utf8')).toBe('original')

      await expect(
        deleteAgentFromFile(authority, definition),
      ).rejects.toThrow('agent role workspace mismatch')
      expect(readFileSync(filePath, 'utf8')).toBe('original')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(foreignRoot, { recursive: true, force: true })
    }
  })

  test('create, update, and delete stay in authority A under ambient cwd B', async () => {
    const authorityRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-authority-a-'))
    const ambientRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-ambient-b-'))
    const roleWorkspace = createAgentRoleWorkspace(authorityRoot)
    const authority = {
      roleWorkspace,
      catalogWorkspaceId: roleWorkspace.id,
    }
    const authorityPath = join(
      authorityRoot,
      '.agenc',
      'agents',
      'scoped-helper.md',
    )
    const ambientPath = join(
      ambientRoot,
      '.agenc',
      'agents',
      'scoped-helper.md',
    )
    const definition = {
      agentType: 'scoped-helper',
      whenToUse: 'Scoped helper',
      source: 'projectSettings' as const,
      getSystemPrompt: () => 'Original prompt',
    }
    try {
      await runWithCwdOverride(ambientRoot, async () => {
        await saveAgentToFile(
          authority,
          'projectSettings',
          'scoped-helper',
          'Scoped helper',
          ['Read'],
          'Original prompt',
        )
        expect(existsSync(authorityPath)).toBe(true)
        expect(existsSync(ambientPath)).toBe(false)
        chmodSync(authorityPath, 0o640)

        await updateAgentFile(
          authority,
          definition,
          'Updated helper',
          ['Read'],
          'Updated prompt',
        )
        expect(readFileSync(authorityPath, 'utf8')).toContain('Updated prompt')
        expect(statSync(authorityPath).mode & 0o777).toBe(0o640)
        expect(existsSync(ambientPath)).toBe(false)

        await deleteAgentFromFile(authority, definition)
        expect(existsSync(authorityPath)).toBe(false)
        expect(existsSync(ambientPath)).toBe(false)
      })
    } finally {
      rmSync(authorityRoot, { recursive: true, force: true })
      rmSync(ambientRoot, { recursive: true, force: true })
    }
  })

  test.each(['.agenc', 'agents'] as const)(
    'rejects a symlinked %s directory without writing through it',
    async symlinkedComponent => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-linked-dir-'))
      const externalRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-external-dir-'))
      const roleWorkspace = createAgentRoleWorkspace(workspaceRoot)
      const authority = {
        roleWorkspace,
        catalogWorkspaceId: roleWorkspace.id,
      }
      const externalAgentPath = symlinkedComponent === '.agenc'
        ? join(externalRoot, 'agents', 'escaped.md')
        : join(externalRoot, 'escaped.md')
      try {
        if (symlinkedComponent === '.agenc') {
          symlinkSync(externalRoot, join(workspaceRoot, '.agenc'), 'dir')
        } else {
          mkdirSync(join(workspaceRoot, '.agenc'))
          symlinkSync(
            externalRoot,
            join(workspaceRoot, '.agenc', 'agents'),
            'dir',
          )
        }

        await expect(
          saveAgentToFile(
            authority,
            'projectSettings',
            'escaped',
            'Escaped role',
            undefined,
            'Must stay in the workspace.',
          ),
        ).rejects.toThrow(/trusted|symlink|directory/i)
        expect(existsSync(externalAgentPath)).toBe(false)
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true })
        rmSync(externalRoot, { recursive: true, force: true })
      }
    },
  )

  test.each(['symlink', 'hardlink'] as const)(
    'rejects an existing %s target without changing the external file',
    async linkType => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-linked-file-'))
      const externalRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-external-file-'))
      const roleWorkspace = createAgentRoleWorkspace(workspaceRoot)
      const authority = {
        roleWorkspace,
        catalogWorkspaceId: roleWorkspace.id,
      }
      const agentDir = join(workspaceRoot, '.agenc', 'agents')
      const externalPath = join(externalRoot, 'outside.md')
      const targetPath = join(agentDir, 'guarded.md')
      const definition = {
        agentType: 'guarded',
        whenToUse: 'Guarded',
        source: 'projectSettings' as const,
        getSystemPrompt: () => 'Original',
      }
      try {
        mkdirSync(agentDir, { recursive: true })
        writeFileSync(externalPath, 'external original', 'utf8')
        if (linkType === 'symlink') {
          symlinkSync(externalPath, targetPath)
        } else {
          linkSync(externalPath, targetPath)
        }

        await expect(
          updateAgentFile(
            authority,
            definition,
            'Changed',
            undefined,
            'Changed prompt',
          ),
        ).rejects.toThrow(/regular|single-link|unsafe|symlink|hardlink/i)
        expect(readFileSync(externalPath, 'utf8')).toBe('external original')
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true })
        rmSync(externalRoot, { recursive: true, force: true })
      }
    },
  )

  test('rejects path components in an agent name before creating a file', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-name-escape-'))
    const roleWorkspace = createAgentRoleWorkspace(workspaceRoot)
    const authority = {
      roleWorkspace,
      catalogWorkspaceId: roleWorkspace.id,
    }
    const escapedPath = join(workspaceRoot, 'escaped.md')
    try {
      await expect(
        saveAgentToFile(
          authority,
          'projectSettings',
          '../../escaped',
          'Escaped role',
          undefined,
          'Must stay in the agent directory.',
        ),
      ).rejects.toThrow(/invalid agent filename/i)
      expect(existsSync(escapedPath)).toBe(false)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  test('detects a directory replacement after pinning without writing externally', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-dir-swap-'))
    const externalRoot = mkdtempSync(join(tmpdir(), 'agenc-agent-dir-swap-outside-'))
    const roleWorkspace = createAgentRoleWorkspace(workspaceRoot)
    const authority = {
      roleWorkspace,
      catalogWorkspaceId: roleWorkspace.id,
    }
    const agentDir = join(workspaceRoot, '.agenc', 'agents')
    const movedAgentDir = join(workspaceRoot, '.agenc', 'original-agents')
    try {
      mkdirSync(agentDir, { recursive: true })
      __setAgentFileOperationHookForTesting(async operation => {
        if (operation.phase !== 'before-commit') return
        __setAgentFileOperationHookForTesting(undefined)
        renameSync(agentDir, movedAgentDir)
        symlinkSync(externalRoot, agentDir, 'dir')
      })

      await expect(
        saveAgentToFile(
          authority,
          'projectSettings',
          'pinned',
          'Pinned role',
          undefined,
          'Must stay in the pinned directory.',
        ),
      ).rejects.toThrow(/directory|trusted|changed/i)
      expect(existsSync(join(externalRoot, 'pinned.md'))).toBe(false)
    } finally {
      __setAgentFileOperationHookForTesting(undefined)
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    }
  })
})
