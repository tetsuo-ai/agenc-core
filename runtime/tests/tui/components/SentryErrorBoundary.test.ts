import React from 'react'
import { describe, expect, test } from 'vitest'

import { SentryErrorBoundary } from './SentryErrorBoundary.js'

describe('SentryErrorBoundary', () => {
  test('renders children before an error is recorded', () => {
    const child = React.createElement('span', null, 'content')
    const boundary = new SentryErrorBoundary({ children: child })

    expect(boundary.state).toEqual({ hasError: false })
    expect(boundary.render()).toBe(child)
  })

  test('marks the boundary as failed and renders nothing after an error', () => {
    expect(SentryErrorBoundary.getDerivedStateFromError()).toEqual({
      hasError: true,
    })

    const boundary = new SentryErrorBoundary({ children: 'hidden' })
    boundary.state = { hasError: true }

    expect(boundary.render()).toBeNull()
  })
})
