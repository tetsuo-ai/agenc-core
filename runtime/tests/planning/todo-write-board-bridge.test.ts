import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPlanningTools } from '../../src/tools/system/planning.js'

// The TodoWrite handler must bridge to the file-backed task board that the
// TUI's TaskListV2 renders via useTasksV2 — otherwise the tool only emits
// plan events and the live todo list in the chat view stays empty.

const ORIGINAL_TASK_LIST_ID = process.env.AGENC_TASK_LIST_ID
const ORIGINAL_CONFIG_DIR = process.env.AGENC_CONFIG_DIR

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agenc-todo-bridge-'))
  process.env.AGENC_CONFIG_DIR = home
  process.env.AGENC_TASK_LIST_ID = 'bridge-test'
})

afterEach(async () => {
  if (ORIGINAL_TASK_LIST_ID === undefined) delete process.env.AGENC_TASK_LIST_ID
  else process.env.AGENC_TASK_LIST_ID = ORIGINAL_TASK_LIST_ID
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.AGENC_CONFIG_DIR
  else process.env.AGENC_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  await rm(home, { recursive: true, force: true })
})

function findTodoWrite() {
  const tool = createPlanningTools().find((candidate) => candidate.name === 'TodoWrite')
  if (!tool) throw new Error('TodoWrite tool not registered')
  return tool
}

async function readBoardTask(contentSlug: string) {
  const path = join(home, 'tasks', 'bridge-test', `tw-${contentSlug}.json`)
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('TodoWrite → task board bridge', () => {
  it('persists todos to the board with stable content-slug ids and ordering', async () => {
    const tool = findTodoWrite()
    const result = await tool.execute({
      todos: [
        { content: 'Explore the codebase', status: 'in_progress', activeForm: 'Exploring the codebase' },
        { content: 'Implement the feature', status: 'pending', activeForm: 'Implementing the feature' },
      ],
    })
    expect(result.isError).not.toBe(true)

    const first = await readBoardTask('explore-the-codebase')
    expect(first.subject).toBe('Explore the codebase')
    expect(first.status).toBe('in_progress')
    expect(first.activeForm).toBe('Exploring the codebase')
    expect(first.blockedBy).toEqual([])

    const second = await readBoardTask('implement-the-feature')
    expect(second.status).toBe('pending')
    expect(second.blockedBy).toEqual(['tw-explore-the-codebase'])
  })

  it('updates status on re-issue and closes tasks dropped from the list', async () => {
    const tool = findTodoWrite()
    await tool.execute({
      todos: [
        { content: 'Explore the codebase', status: 'in_progress', activeForm: 'Exploring the codebase' },
        { content: 'Implement the feature', status: 'pending', activeForm: 'Implementing the feature' },
      ],
    })
    await tool.execute({
      todos: [
        { content: 'Explore the codebase', status: 'completed', activeForm: 'Exploring the codebase' },
      ],
    })

    const first = await readBoardTask('explore-the-codebase')
    expect(first.status).toBe('completed')

    // Dropped from the rewritten list → closed out, not left dangling.
    const second = await readBoardTask('implement-the-feature')
    expect(second.status).toBe('completed')
  })

  it('still returns the donor success message', async () => {
    const tool = findTodoWrite()
    const result = await tool.execute({
      todos: [
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      ],
    })
    const text = JSON.stringify(result)
    expect(text).toContain('Todos have been modified successfully')
  })
})
