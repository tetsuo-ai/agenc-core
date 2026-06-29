import React from 'react'
import { describe, expect, test } from 'vitest'

import { TuiErrorBoundary } from './TuiErrorBoundary.js'

describe('TuiErrorBoundary', () => {
  test('renders children before an error is recorded', () => {
    const child = React.createElement('span', null, 'content')
    const boundary = new TuiErrorBoundary({ children: child })

    expect(boundary.state).toEqual({ hasError: false })
    expect(boundary.render()).toBe(child)
  })

  test('marks the boundary as failed and renders nothing after an error', () => {
    expect(TuiErrorBoundary.getDerivedStateFromError()).toEqual({
      hasError: true,
    })

    const boundary = new TuiErrorBoundary({ children: 'hidden' })
    boundary.state = { hasError: true }

    expect(boundary.render()).toBeNull()
  })
})
