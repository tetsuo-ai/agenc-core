import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const selectProps = vi.hoisted(() => ({
  current: undefined as undefined | {
    options: Array<{ label: React.ReactNode; value: string }>
    onChange: (value: string) => void
    onCancel: () => void
  },
}))

vi.mock('../../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

vi.mock('../../CustomSelect/select', () => ({
  Select: (props: {
    options: Array<{ label: React.ReactNode; value: string }>
    onChange: (value: string) => void
    onCancel: () => void
  }) => {
    selectProps.current = props
    return null
  },
}))

vi.mock('../hooks', () => ({
  usePermissionRequestLogging: () => {},
}))

vi.mock('../PermissionDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    PermissionDialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

vi.mock('../PermissionRuleExplanation', () => ({
  PermissionRuleExplanation: () => null,
}))

vi.mock('../../../../utils/permissions/permissionsLoader', () => ({
  shouldShowAlwaysAllowOptions: () => true,
}))

function collectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return collectText(node.props.children)
  }
  return ''
}

function makeProps(url: string) {
  const toolUseConfirm = {
    input: {
      url,
      prompt: 'summarize',
    },
    tool: {
      name: 'WebFetch',
      isMcp: false,
      userFacingName: () => 'Fetch',
    },
    assistantMessage: {
      message: { id: 'msg_webfetch' },
    },
    description: 'fetch a URL',
    toolUseContext: {},
    toolUseID: 'toolu_webfetch',
    permissionResult: { behavior: 'ask' },
    permissionPromptStartTimeMs: 0,
    onUserInteraction: vi.fn(),
    onAbort: vi.fn(),
    onAllow: vi.fn(),
    onReject: vi.fn(),
    recheckPermission: vi.fn(),
  }

  return {
    toolUseConfirm,
    toolUseContext: {},
    onDone: vi.fn(),
    onReject: vi.fn(),
    verbose: false,
    workerBadge: undefined,
  } as never
}

describe('WebFetchPermissionRequest', () => {
  beforeEach(() => {
    selectProps.current = undefined
  })

  it('renders malformed URL input without throwing', async () => {
    const { WebFetchPermissionRequest } = await import(
      './WebFetchPermissionRequest.js'
    )

    const output = await renderToString(
      <WebFetchPermissionRequest {...makeProps('not a url')} />,
      80,
    )

    expect(output).toContain('not a url')
    expect(output).toContain('Do you want to allow AgenC to fetch this content?')
    expect(selectProps.current?.options.map(option => option.value)).toEqual([
      'yes',
      'no',
    ])
  })

  it('keeps the domain always-allow option for valid URL input', async () => {
    const { WebFetchPermissionRequest } = await import(
      './WebFetchPermissionRequest.js'
    )

    await renderToString(
      <WebFetchPermissionRequest {...makeProps('https://example.com/a')} />,
      80,
    )

    expect(selectProps.current?.options.map(option => option.value)).toEqual([
      'yes',
      'yes-dont-ask-again-domain',
      'no',
    ])
  })

  it('does not advertise reject feedback when the dialog cannot collect it', async () => {
    const { WebFetchPermissionRequest } = await import(
      './WebFetchPermissionRequest.js'
    )

    await renderToString(
      <WebFetchPermissionRequest {...makeProps('https://example.com/a')} />,
      80,
    )

    const denyOption = selectProps.current?.options.find(
      option => option.value === 'no',
    )

    expect(collectText(denyOption?.label)).toBe('No, deny fetch')
    expect(collectText(denyOption?.label)).not.toContain('tell AgenC')
    expect(collectText(denyOption?.label)).not.toContain('(esc)')
  })
})
