import React, { useLayoutEffect, useState } from 'react'
import { describe, expect, test } from 'vitest'

import {
  getShutdownMessageSummary,
  ShutdownRejectedDisplay,
  ShutdownRequestDisplay,
  tryRenderShutdownMessage,
} from '../../../src/tui/message-renderers/ShutdownMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

function shutdownPayload(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    requestId: 'shutdown-row-132',
    timestamp: '2026-05-20T00:00:00.000Z',
    ...overrides,
  })
}

function requestPayload(reason?: string): string {
  return shutdownPayload({
    type: 'shutdown_request',
    from: 'lead',
    ...(reason === undefined ? {} : { reason }),
  })
}

function rejectedPayload(reason = 'still flushing logs'): string {
  return shutdownPayload({
    type: 'shutdown_rejected',
    from: 'worker-132',
    reason,
  })
}

function approvedPayload(): string {
  return shutdownPayload({
    type: 'shutdown_approved',
    from: 'worker-132',
  })
}

function RerenderShutdownRequest() {
  const [count, setCount] = useState(0)

  useLayoutEffect(() => {
    if (count === 0) setCount(1)
  }, [count])

  return (
    <ShutdownRequestDisplay
      request={{
        type: 'shutdown_request',
        requestId: 'shutdown-rerender-request',
        from: 'lead',
        reason: 'same reason',
        timestamp: '2026-05-20T00:00:00.000Z',
      }}
    />
  )
}

function RerenderShutdownRejected() {
  const [count, setCount] = useState(0)

  useLayoutEffect(() => {
    if (count === 0) setCount(1)
  }, [count])

  return (
    <ShutdownRejectedDisplay
      response={{
        type: 'shutdown_rejected',
        requestId: 'shutdown-rerender-rejected',
        from: 'worker-132',
        reason: 'same rejection',
        timestamp: '2026-05-20T00:00:00.000Z',
      }}
    />
  )
}

async function renderShutdownContent(content: string): Promise<string> {
  const node = tryRenderShutdownMessage(content)
  if (!React.isValidElement(node)) {
    throw new Error('expected a rendered shutdown message')
  }
  return renderToString(<>{node}</>, { columns: 100, rows: 12 })
}

describe('ShutdownMessage coverage swarm 132', () => {
  test('renders shutdown requests with and without optional reasons', async () => {
    const withReason = await renderShutdownContent(requestPayload('handoff done'))
    expect(withReason).toContain('Shutdown request from lead')
    expect(withReason).toContain('Reason: handoff done')

    const withoutReason = await renderShutdownContent(requestPayload())
    expect(withoutReason).toContain('Shutdown request from lead')
    expect(withoutReason).not.toContain('Reason:')
  })

  test('renders shutdown rejection details and continuation guidance', async () => {
    const output = await renderShutdownContent(rejectedPayload())

    expect(output).toContain('Shutdown rejected by worker-132')
    expect(output).toContain('Reason: still flushing logs')
    expect(output).toContain(
      'Teammate is continuing to work. You may request shutdown again later.',
    )
  })

  test('suppresses approved and invalid shutdown payloads', () => {
    expect(tryRenderShutdownMessage(approvedPayload())).toBeNull()
    expect(tryRenderShutdownMessage('not json')).toBeNull()
    expect(
      tryRenderShutdownMessage(
        JSON.stringify({
          type: 'shutdown_request',
          from: 'lead',
        }),
      ),
    ).toBeNull()
  })

  test('summarizes every shutdown lifecycle variant', () => {
    expect(getShutdownMessageSummary(requestPayload())).toBe(
      '[Shutdown Request from lead]',
    )
    expect(getShutdownMessageSummary(requestPayload('handoff done'))).toBe(
      '[Shutdown Request from lead] handoff done',
    )
    expect(getShutdownMessageSummary(approvedPayload())).toBe(
      '[Shutdown Approved] worker-132 is now exiting',
    )
    expect(getShutdownMessageSummary(rejectedPayload('tests still running'))).toBe(
      '[Shutdown Rejected] worker-132: tests still running',
    )
    expect(getShutdownMessageSummary('not json')).toBeNull()
  })

  test('keeps memoized renderer output stable across rerenders', async () => {
    const requestOutput = await renderToString(<RerenderShutdownRequest />, {
      columns: 100,
      rows: 12,
    })
    expect(requestOutput).toContain('Shutdown request from lead')
    expect(requestOutput).toContain('Reason: same reason')

    const rejectedOutput = await renderToString(<RerenderShutdownRejected />, {
      columns: 100,
      rows: 12,
    })
    expect(rejectedOutput).toContain('Shutdown rejected by worker-132')
    expect(rejectedOutput).toContain('Reason: same rejection')
  })
})
