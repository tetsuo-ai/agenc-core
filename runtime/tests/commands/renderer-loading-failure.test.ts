import { expect, test, vi } from 'vitest'
import type { SlashCommandContext } from '../../src/commands/types.js'

vi.mock('react', () => { throw new Error('renderer unavailable') })
vi.mock('../../src/tui/components/tasks/BackgroundTasksPanel.js', () => ({ BackgroundTasksPanel: () => null }))

test('a renderer failure remains inside safeExecute and never publishes partial UI', async () => {
  const { tasksCommand } = await import('../../src/commands/tasks.js')
  const context = { argsRaw: '', session: { services: {} }, cwd: '/tmp', home: '/tmp' } as unknown as SlashCommandContext
  expect((await tasksCommand.execute(context)).kind).toBe('text')
  const setToolJSX = vi.fn()
  expect((await tasksCommand.execute({ ...context, appState: { setToolJSX } })).kind).toBe('error')
  expect(setToolJSX).not.toHaveBeenCalled()
})
