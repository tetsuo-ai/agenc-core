import { describe, expect, test } from 'vitest'

import {
  buildMemoryFileSelectorOptions,
  getInitialMemoryPath,
  OPEN_FOLDER_PREFIX,
  type AgentMemoryDefinitionForSelector,
  type MemorySelectorFileInfo,
} from './selector-options.js'

const userMemoryPath = '/home/user/.agenc/AGENC.md'
const projectMemoryPath = '/repo/AGENC.md'
const autoMemoryPath = '/repo/.agenc/auto-memory'
const teamMemoryPath = '/repo/.agenc/team-memory'

function buildOptions(overrides: {
  readonly existingMemoryFiles?: readonly MemorySelectorFileInfo[]
  readonly autoMemoryEnabled?: boolean
  readonly teamMemoryEnabled?: boolean
  readonly teamMemoryPath?: string
  readonly activeAgents?: readonly AgentMemoryDefinitionForSelector[]
  readonly projectInGitRepo?: boolean
} = {}) {
  return buildMemoryFileSelectorOptions({
    existingMemoryFiles: overrides.existingMemoryFiles ?? [],
    userMemoryPath,
    projectMemoryPath,
    autoMemoryEnabled: overrides.autoMemoryEnabled ?? false,
    autoMemoryPath,
    teamMemoryEnabled: overrides.teamMemoryEnabled ?? false,
    teamMemoryPath: overrides.teamMemoryPath,
    activeAgents: overrides.activeAgents ?? [],
    projectInGitRepo: overrides.projectInGitRepo ?? true,
    displayPathFor: path => path.replace('/repo/', '').replace('/home/user/', '~/'),
    agentMemoryDirFor: (agentType, scope) => `/agents/${scope}/${agentType}`,
  })
}

describe('memory selector options', () => {
  test('adds absent user and project memory options when files do not exist', () => {
    expect(buildOptions()).toEqual([
      {
        label: 'User memory',
        value: userMemoryPath,
        description: 'Saved in ~/.agenc/AGENC.md',
        kind: 'user',
        state: 'absent',
      },
      {
        label: 'Project memory',
        value: projectMemoryPath,
        description: 'Checked in at ./AGENC.md',
        kind: 'project',
        state: 'absent',
      },
    ])
  })

  test('formats present, imported, nested, and dynamic memory files', () => {
    const options = buildOptions({
      existingMemoryFiles: [
        {
          path: userMemoryPath,
          type: 'User',
          content: 'user',
        },
        {
          path: projectMemoryPath,
          type: 'Project',
          content: 'project',
        },
        {
          path: '/repo/imported.md',
          type: 'Project',
          parent: projectMemoryPath,
          content: 'imported',
        },
        {
          path: '/repo/imported/deep.md',
          type: 'Project',
          parent: '/repo/imported.md',
          content: 'deep',
        },
        {
          path: '/repo/orphan-import.md',
          type: 'Project',
          parent: '/repo/not-yet-listed.md',
          content: 'orphan',
        },
        {
          path: '/repo/dynamic.md',
          type: 'Project',
          isNested: true,
          content: 'dynamic',
        },
        {
          path: '/repo/pinned.md',
          type: 'Pinned',
          content: 'top-level memory',
        },
        {
          path: '/repo/auto.md',
          type: 'AutoMem',
          content: 'filtered',
        },
        {
          path: '/repo/team.md',
          type: 'TeamMem',
          content: 'filtered',
        },
      ],
      projectInGitRepo: false,
    })

    expect(options).toEqual([
      {
        label: 'User memory',
        value: userMemoryPath,
        description: 'Saved in ~/.agenc/AGENC.md',
        kind: 'user',
        state: 'present',
      },
      {
        label: 'Project memory',
        value: projectMemoryPath,
        description: 'Saved in ./AGENC.md',
        kind: 'project',
        state: 'present',
      },
      {
        label: 'L imported.md',
        value: '/repo/imported.md',
        description: '@-imported',
        kind: 'import',
        state: 'present',
      },
      {
        label: '  L imported/deep.md',
        value: '/repo/imported/deep.md',
        description: '@-imported',
        kind: 'import',
        state: 'present',
      },
      {
        label: 'L orphan-import.md',
        value: '/repo/orphan-import.md',
        description: '@-imported',
        kind: 'import',
        state: 'present',
      },
      {
        label: 'dynamic.md',
        value: '/repo/dynamic.md',
        description: 'dynamically loaded',
        kind: 'memory',
        state: 'present',
      },
      {
        label: 'pinned.md',
        value: '/repo/pinned.md',
        description: '',
        kind: 'memory',
        state: 'present',
      },
    ])
  })

  test('adds folder and scoped agent entries only when auto-memory is enabled', () => {
    const disabled = buildOptions({
      autoMemoryEnabled: false,
      teamMemoryEnabled: true,
      teamMemoryPath,
      activeAgents: [
        { agentType: 'reviewer', memory: 'project' },
      ],
    })

    expect(disabled.map(option => option.kind)).toEqual(['user', 'project'])

    const enabled = buildOptions({
      autoMemoryEnabled: true,
      teamMemoryEnabled: true,
      teamMemoryPath,
      activeAgents: [
        { agentType: 'reviewer', memory: 'project' },
        { agentType: 'localizer', memory: 'local' },
        { agentType: 'global', memory: 'user' },
        { agentType: 'disabled', memory: false },
        { agentType: 'none', memory: null },
        { agentType: 'missing' },
      ],
    })

    expect(enabled.slice(2)).toEqual([
      {
        label: 'Open auto-memory folder',
        value: `${OPEN_FOLDER_PREFIX}${autoMemoryPath}`,
        description: '',
        kind: 'folder',
        state: 'folder',
      },
      {
        label: 'Open team memory folder',
        value: `${OPEN_FOLDER_PREFIX}${teamMemoryPath}`,
        description: '',
        kind: 'folder',
        state: 'folder',
      },
      {
        label: 'Open reviewer agent memory',
        value: `${OPEN_FOLDER_PREFIX}/agents/project/reviewer`,
        description: 'project scope',
        kind: 'agent',
        state: 'folder',
      },
      {
        label: 'Open localizer agent memory',
        value: `${OPEN_FOLDER_PREFIX}/agents/local/localizer`,
        description: 'local scope',
        kind: 'agent',
        state: 'folder',
      },
      {
        label: 'Open global agent memory',
        value: `${OPEN_FOLDER_PREFIX}/agents/user/global`,
        description: 'user scope',
        kind: 'agent',
        state: 'folder',
      },
    ])
  })

  test('skips team folder without a path and chooses the initial selection', () => {
    const options = buildOptions({
      autoMemoryEnabled: true,
      teamMemoryEnabled: true,
      teamMemoryPath: undefined,
    })

    expect(options.map(option => option.label)).toEqual([
      'User memory',
      'Project memory',
      'Open auto-memory folder',
    ])
    expect(getInitialMemoryPath(options, projectMemoryPath)).toBe(projectMemoryPath)
    expect(getInitialMemoryPath(options, '/missing.md')).toBe(userMemoryPath)
    expect(getInitialMemoryPath([], '/missing.md')).toBe('')
  })
})
