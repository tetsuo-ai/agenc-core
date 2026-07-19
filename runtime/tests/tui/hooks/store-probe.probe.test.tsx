process.env.AGENC_CONFIG_DIR = '/home/paul/.agenc'
process.env.AGENC_TASK_LIST_ID = 'bridge-live'

import { describe, expect, it, vi } from 'vitest'
import React from 'react'

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({}),
}))
vi.mock('../../../src/tui/state/AppState.js', async () => {
  const ReactModule = await import('react')
  const state = {
    tasks: {},
    expandedView: 'none',
    viewingAgentTaskId: undefined,
    selectedIPAgentIndex: 0,
    viewSelectionMode: undefined,
    teamContext: null,
    isBriefOnly: false,
  }
  return {
    useAppState: (selector) => selector(state),
    useSetAppState: () => () => {},
    AppStateProvider: ({ children }) => ReactModule.createElement(ReactModule.Fragment, null, children),
  }
})

import { renderToString } from '../../utils/staticRender.js'
import { SpinnerWithVerbInner } from '../../../src/tui/components/spinner/Spinner.js'

describe('spinner todo auto-show against a live board', () => {
  it('renders the task list when the board has open tasks', async () => {
    const { useTasksV2 } = await import('../../../src/tui/hooks/useTasksV2.js')
    const { useSyncExternalStore } = React
    function Probe() {
      const tasks = useTasksV2()
      return <>{tasks ? tasks.map(t => `${t.status}:${t.subject}`).join(' | ') : 'NO-TASKS'}</>
    }
    const out = await renderToString(<Probe />)
    await new Promise(r => setTimeout(r, 300))
    const out2 = await renderToString(<Probe />)
    console.log('probe1:', out)
    console.log('probe2:', out2)
    expect(out2).not.toContain('NO-TASKS')
  })
})
