import { expect, test, vi } from 'vitest'
import type { SlashCommandContext } from '../../src/commands/types.js'

const state = vi.hoisted(() => ({ reactLoads: 0 }))
vi.mock('react', async original => {
  state.reactLoads++
  return original()
})
vi.mock('../../src/tui/components/HelpV2/HelpV2.js', () => ({ HelpV2: () => null }))
vi.mock('../../src/tui/components/v2/CostUsageModal.js', () => ({ CostUsageModal: () => null }))
vi.mock('../../src/commands/hooks-menu.js', () => ({ HooksRuntimeUnavailableModal: () => null }))
vi.mock('../../src/tui/components/tasks/BackgroundTasksPanel.js', () => ({ BackgroundTasksPanel: () => null }))

test('headless command paths avoid React and interactive paths retain element and close behavior', async () => {
  const [{ helpCommand }, { costCommand }, { default: hooksCommand }, { tasksCommand }] = await Promise.all([
    import('../../src/commands/help.js'), import('../../src/commands/cost.js'),
    import('../../src/commands/hooks.js'), import('../../src/commands/tasks.js'),
  ])
  const commands = [helpCommand, costCommand, hooksCommand, tasksCommand]
  const context = {
    argsRaw: '', cwd: '/tmp/project', home: '/tmp',
    session: { services: { configStore: { stateRepository: { get: () => ({}) } } } },
    commandRegistry: { list: () => commands },
  } as unknown as SlashCommandContext
  expect(state.reactLoads).toBe(0)
  for (const command of commands) {
    const result = await command.execute(context)
    if (command === hooksCommand) {
      expect(result).toEqual({ kind: 'error', message: 'Hooks runtime is not available in this session.' })
    } else {
      expect(result.kind, command.name).toBe('text')
    }
  }
  expect(state.reactLoads).toBe(0)

  for (const command of commands) {
    const setToolJSX = vi.fn()
    expect(await command.execute({ ...context, appState: { setToolJSX } })).toEqual({ kind: 'skip' })
    const shown = setToolJSX.mock.calls[0]![0]
    expect(shown).toMatchObject({ isLocalJSXCommand: true, shouldHidePromptInput: true })
    expect(typeof shown.jsx.type).toBe('function')
    const close = shown.jsx.props.onClose ?? shown.jsx.props.onDone
    close()
    expect(setToolJSX).toHaveBeenLastCalledWith({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })
  }
  expect(state.reactLoads).toBe(1)
})
