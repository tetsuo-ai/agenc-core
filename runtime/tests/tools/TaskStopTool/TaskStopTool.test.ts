import { describe, expect, test } from 'vitest'

import { TaskStopTool } from '../../../src/tools/TaskStopTool/TaskStopTool.js'

type MutableState = { tasks: Record<string, unknown> }

// Minimal getAppState/setAppState backing store — TaskStopTool.call only reads
// `.tasks` and applies setAppState updaters, so a partial AppState suffices.
function makeContext(tasks: Record<string, unknown>) {
  let state: MutableState = { tasks }
  return {
    getAppState: () => state,
    setAppState: (updater: (prev: MutableState) => MutableState) => {
      state = updater(state)
    },
    current: () => state,
  }
}

const NOOP_CAN_USE_TOOL = (async () => undefined) as never

describe('TaskStopTool', () => {
  test('stops a running local_agent task and cancels its work (regression: the old call passed {getAppState,setAppState} to stopTask and threw "context.getTask is not a function")', async () => {
    const abort = new AbortController()
    let aborted = false
    abort.signal.addEventListener('abort', () => {
      aborted = true
    })
    const ctx = makeContext({
      'agent-1': {
        id: 'agent-1',
        type: 'local_agent',
        status: 'running',
        description: 'do the thing',
        abortController: abort,
      },
    })

    const result = await TaskStopTool.call(
      { task_id: 'agent-1' },
      ctx as never,
      NOOP_CAN_USE_TOOL,
      {} as never,
    )

    expect(result.data.task_id).toBe('agent-1')
    expect(result.data.task_type).toBe('local_agent')
    expect(result.data.command).toBe('do the thing')
    // The fix actually cancels the work (aborts) and marks the task killed.
    expect(aborted).toBe(true)
    expect((ctx.current().tasks['agent-1'] as { status: string }).status).toBe(
      'killed',
    )
  })

  test('throws a clear error when the task does not exist', async () => {
    const ctx = makeContext({})
    await expect(
      TaskStopTool.call(
        { task_id: 'missing' },
        ctx as never,
        NOOP_CAN_USE_TOOL,
        {} as never,
      ),
    ).rejects.toThrow('No task found with ID: missing')
  })
})
