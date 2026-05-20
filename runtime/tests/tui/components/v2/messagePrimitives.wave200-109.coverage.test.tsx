import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  RejectedPlanMessage,
  RejectedToolUseMessage,
  UserImageMessage,
  UserToolCanceledMessage,
} from './messagePrimitives.js'

const imageHarness = vi.hoisted(() => ({
  hyperlinks: false,
  storedPath: null as string | null,
}))

vi.mock('../../../utils/imageStore.js', () => ({
  getStoredImagePath: () => imageHarness.storedPath,
}))

vi.mock('../../ink/supports-hyperlinks.js', () => ({
  supportsHyperlinks: () => imageHarness.hyperlinks,
}))

describe('messagePrimitives wave200-109 coverage', () => {
  test('renders image and rejected control rows through v2 chrome', async () => {
    imageHarness.hyperlinks = true
    imageHarness.storedPath = '/tmp/agenc-screenshot.png'

    const linkedImageOutput = await renderToString(
      <UserImageMessage imageId={42} />,
      100,
    )

    expect(linkedImageOutput).toContain('IMAGE')
    expect(linkedImageOutput).toContain('[ image')
    expect(linkedImageOutput).toContain('#42')

    imageHarness.hyperlinks = false
    imageHarness.storedPath = null

    const plainImageOutput = await renderToString(<UserImageMessage />, 100)

    expect(plainImageOutput).toContain('IMAGE')
    expect(plainImageOutput).toContain('[ image ]')

    const rejectedToolOutput = await renderToString(
      <RejectedToolUseMessage />,
      100,
    )
    const canceledToolOutput = await renderToString(
      <UserToolCanceledMessage />,
      100,
    )
    const rejectedPlanOutput = await renderToString(
      <AppStateProvider>
        <RejectedPlanMessage plan="1. Inspect the proposed edit" />
      </AppStateProvider>,
      100,
    )

    expect(rejectedToolOutput).toContain('PERMISSION')
    expect(rejectedToolOutput).toContain('Tool use rejected')
    expect(canceledToolOutput).toContain('INTERRUPT')
    expect(canceledToolOutput).toContain('Interrupted by user')
    expect(rejectedPlanOutput).toContain('PLAN REJECTED')
    expect(rejectedPlanOutput).toContain("User rejected AgenC's plan:")
    expect(rejectedPlanOutput).toContain('PLAN TO IMPLEMENT')
    expect(rejectedPlanOutput).toContain('Inspect the proposed edit')
  })
})
