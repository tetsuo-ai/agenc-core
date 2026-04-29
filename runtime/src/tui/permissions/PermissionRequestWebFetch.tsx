/**
 * Per-tool permission dialog body for WebFetch / WebSearch tools.
 *
 * Ported from upstream. Surfaces the requested URL or query plus an
 * optional prompt, and offers a domain-scope "always allow this host"
 * option so an operator can avoid being re-prompted for repeated
 * fetches against the same hostname.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { PermissionRequestProps } from './PermissionRequest.js'

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function truncateInline(value: string, max = 120): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function safeHostname(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

type SelectValue = 'yes' | 'yes-domain' | 'no'

export const PermissionRequestWebFetch: React.FC<PermissionRequestProps> = ({
  subject,
  onResolve,
  onCancel,
}) => {
  const url = coerceString(subject.toolInput.url)
  const query = coerceString(subject.toolInput.query ?? subject.toolInput.q)
  const prompt = coerceString(subject.toolInput.prompt)
  const hostname = useMemo(() => safeHostname(url), [url])

  const handleCancel = useCallback(() => {
    onResolve({ behavior: 'abort' })
    onCancel?.()
  }, [onCancel, onResolve])

  const handleChange = useCallback(
    (value: SelectValue) => {
      switch (value) {
        case 'yes':
          onResolve({ behavior: 'allow' })
          return
        case 'yes-domain':
          onResolve({ behavior: 'allow-session', addRule: true })
          return
        case 'no':
          onResolve({ behavior: 'deny' })
          return
      }
    },
    [onResolve],
  )

  const options = useMemo(() => {
    const entries: Array<{ value: SelectValue; label: React.ReactNode }> = [
      { value: 'yes', label: 'Yes' },
    ]
    if (hostname) {
      entries.push({
        value: 'yes-domain',
        label: (
          <Text>
            Yes, and don&apos;t ask again for{' '}
            <Text bold={true}>{hostname}</Text>
          </Text>
        ),
      })
    }
    entries.push({
      value: 'no',
      label: 'No, tell AgenC what to do differently',
    })
    return entries
  }, [hostname])

  return (
    <Dialog title="Fetch" onCancel={handleCancel}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {url ? <Text>{`url · ${truncateInline(url, 120)}`}</Text> : null}
        {query ? <Text>{`query · ${truncateInline(query, 120)}`}</Text> : null}
        {prompt ? (
          <Text dimColor={true}>{`prompt · ${truncateInline(prompt, 200)}`}</Text>
        ) : null}
        {!url && !query && !prompt ? (
          <Text dimColor={true}>web request</Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <Text>Do you want to allow AgenC to fetch this content?</Text>
        <Select<SelectValue>
          options={options}
          onChange={handleChange}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default PermissionRequestWebFetch
