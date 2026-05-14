import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(() => new Promise<string>(() => {})),
}))

vi.mock('../../../../utils/fsOperations.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/fsOperations.js')>()
  return {
    ...actual,
    getFsImplementation: () => fsMock,
  }
})

vi.mock('../../design-system/LoadingState', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    LoadingState: ({ message }: { message: string }) =>
      ReactActual.createElement(Text, null, message),
  }
})

describe('NotebookEditToolDiff', () => {
  beforeEach(() => {
    fsMock.readFile.mockReset()
    fsMock.readFile.mockImplementation(() => new Promise<string>(() => {}))
  })

  it('renders a loading frame while notebook contents are pending', async () => {
    const { NotebookEditToolDiff } = await import('./NotebookEditToolDiff.js')

    const output = await renderToString(
      <NotebookEditToolDiff
        notebook_path="/tmp/agenc-notebook.ipynb"
        cell_id="0"
        new_source="print('new')"
        cell_type="code"
        edit_mode="replace"
        verbose={false}
        width={20}
      />,
      80,
    )

    expect(output).toContain('agenc-notebook.ipynb')
    expect(output).toContain('Loading notebook preview...')
  })

  it('turns malformed notebook JSON into a visible load error', async () => {
    fsMock.readFile.mockResolvedValueOnce('{not json')
    const { loadNotebookPreview } = await import('./NotebookEditToolDiff.js')

    await expect(loadNotebookPreview('/tmp/bad.ipynb')).resolves.toMatchObject({
      status: 'error',
      message: 'Could not parse notebook JSON.',
    })
  })

  it('turns notebook read failures into a visible load error', async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error('permission denied'))
    const { loadNotebookPreview } = await import('./NotebookEditToolDiff.js')

    await expect(
      loadNotebookPreview('/tmp/unreadable.ipynb'),
    ).resolves.toMatchObject({
      status: 'error',
      message: 'permission denied',
    })
  })
})
