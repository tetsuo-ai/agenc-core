import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'

const selectProps = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        options: Array<{ value: string; label: React.ReactNode }>
        onChange: (value: 'merge' | 'keep' | 'replace') => void
        onCancel?: () => void
      },
}))

vi.mock('../CustomSelect/select', () => ({
  Select: (props: {
    options: Array<{ value: string; label: React.ReactNode }>
    onChange: (value: 'merge' | 'keep' | 'replace') => void
    onCancel?: () => void
  }) => {
    selectProps.current = props
    return null
  },
}))

vi.mock('../design-system/Dialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    Dialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

describe('SnapshotUpdateDialog', () => {
  beforeEach(() => {
    selectProps.current = undefined
  })

  it('renders snapshot context and exposes all update choices', async () => {
    const { SnapshotUpdateDialog } = await import('./SnapshotUpdateDialog.js')

    const output = await renderToString(
      <SnapshotUpdateDialog
        agentType="reviewer"
        scope="user"
        snapshotTimestamp="2026-05-14T04:00:00.000Z"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
      100,
    )

    expect(output).toContain('A newer project snapshot is available')
    expect(output).toContain('Snapshot updated:')
    expect(selectProps.current?.options.map(option => option.value)).toEqual([
      'merge',
      'keep',
      'replace',
    ])
  })

  it('returns the selected choice and preserves cancel as a separate path', async () => {
    const onComplete = vi.fn()
    const onCancel = vi.fn()
    const { SnapshotUpdateDialog } = await import('./SnapshotUpdateDialog.js')

    await renderToString(
      <SnapshotUpdateDialog
        agentType="reviewer"
        scope="local"
        snapshotTimestamp="bad timestamp"
        onComplete={onComplete}
        onCancel={onCancel}
      />,
      100,
    )

    if (!selectProps.current) {
      throw new Error('SnapshotUpdateDialog did not render Select')
    }
    selectProps.current.onChange('replace')
    selectProps.current.onCancel?.()

    expect(onComplete).toHaveBeenCalledWith('replace')
    expect(onCancel).toHaveBeenCalled()
  })
})
