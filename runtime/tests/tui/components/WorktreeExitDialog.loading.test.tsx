import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { WorktreeExitLoadingState } from './WorktreeExitDialog.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('./spinner/Spinner.js', () => ({
  Spinner: () => null,
}))

describe('WorktreeExitLoadingState', () => {
  it('renders visible progress while worktree status is loading', async () => {
    const output = await renderToString(<WorktreeExitLoadingState />, 80)

    expect(output).toContain('Checking worktree...')
  })
})
