import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import {
  getShutdownMessageSummary,
  tryRenderShutdownMessage,
} from './ShutdownMessage.js'

function shutdownPayload(payload: Record<string, unknown>): string {
  return JSON.stringify({
    requestId: 'shutdown-worker-one',
    timestamp: '2026-05-20T00:00:00.000Z',
    ...payload,
  })
}

describe('ShutdownMessage coverage', () => {
  test('renders request and rejection payloads while summarizing shutdown lifecycle messages', async () => {
    const request = shutdownPayload({
      type: 'shutdown_request',
      from: 'lead',
      reason: 'Rotate credentials',
    })
    const rejected = shutdownPayload({
      type: 'shutdown_rejected',
      from: 'worker-one',
      reason: 'Need to finish current edit',
    })
    const approved = shutdownPayload({
      type: 'shutdown_approved',
      from: 'worker-one',
    })

    const requestNode = tryRenderShutdownMessage(request)
    expect(React.isValidElement(requestNode)).toBe(true)
    const requestOutput = await renderToString(requestNode, { columns: 100 })
    expect(requestOutput).toContain('Shutdown request from lead')
    expect(requestOutput).toContain('Reason: Rotate credentials')

    const rejectedNode = tryRenderShutdownMessage(rejected)
    expect(React.isValidElement(rejectedNode)).toBe(true)
    const rejectedOutput = await renderToString(rejectedNode, { columns: 100 })
    expect(rejectedOutput).toContain('Shutdown rejected by worker-one')
    expect(rejectedOutput).toContain('Reason: Need to finish current edit')
    expect(rejectedOutput).toContain(
      'Teammate is continuing to work. You may request shutdown again later.',
    )

    expect(tryRenderShutdownMessage(approved)).toBeNull()
    expect(tryRenderShutdownMessage('plain message')).toBeNull()
    expect(getShutdownMessageSummary(request)).toBe(
      '[Shutdown Request from lead] Rotate credentials',
    )
    expect(getShutdownMessageSummary(approved)).toBe(
      '[Shutdown Approved] worker-one is now exiting',
    )
    expect(getShutdownMessageSummary(rejected)).toBe(
      '[Shutdown Rejected] worker-one: Need to finish current edit',
    )
    expect(getShutdownMessageSummary('plain message')).toBeNull()
  })
})
