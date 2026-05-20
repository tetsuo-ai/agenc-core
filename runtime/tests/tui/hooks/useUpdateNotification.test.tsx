import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import Text from '../ink/components/Text.js'
import {
  getSemverPart,
  shouldShowUpdateNotification,
  useUpdateNotification,
} from './useUpdateNotification.js'

function UpdateNotificationProbe({
  initialVersion,
  seen,
  updatedVersion,
}: {
  initialVersion: string
  seen: Array<string | null>
  updatedVersion: string | null | undefined
}) {
  const result = useUpdateNotification(updatedVersion, initialVersion)
  seen.push(result)

  return <Text>{result ?? 'none'}</Text>
}

async function renderProbe(
  updatedVersion: string | null | undefined,
  initialVersion = '1.2.3',
): Promise<Array<string | null>> {
  const seen: Array<string | null> = []
  await renderToString(
    <UpdateNotificationProbe
      initialVersion={initialVersion}
      seen={seen}
      updatedVersion={updatedVersion}
    />,
    80,
  )
  return seen
}

describe('useUpdateNotification helpers', () => {
  test('normalizes loose versions to semver parts', () => {
    expect(getSemverPart('v1.2.3-beta.4')).toBe('1.2.3')
    expect(getSemverPart('2.0.1+build.7')).toBe('2.0.1')
  })

  test('detects unseen update semver values', () => {
    expect(shouldShowUpdateNotification('1.2.4', '1.2.3')).toBe(true)
    expect(shouldShowUpdateNotification('v1.2.3-beta.4', '1.2.3')).toBe(false)
  })
})

describe('useUpdateNotification', () => {
  test('returns null without an updated version', async () => {
    await expect(renderProbe(null)).resolves.toEqual([null])
    await expect(renderProbe(undefined)).resolves.toEqual([null])
  })

  test('returns null when the update matches the initial semver', async () => {
    await expect(renderProbe('v1.2.3-beta.1')).resolves.toEqual([null])
  })

  test('reports a new semver once and stores it as notified', async () => {
    await expect(renderProbe('1.2.4')).resolves.toContain('1.2.4')
  })
})
