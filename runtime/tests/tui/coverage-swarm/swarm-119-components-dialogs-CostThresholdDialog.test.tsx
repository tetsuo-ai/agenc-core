import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { CostThresholdDialog } from '../../../src/tui/components/dialogs/CostThresholdDialog.js'
import { renderToString } from '../../../src/utils/staticRender.js'

type DialogProps = {
  readonly children: ReactNode
  readonly onCancel: () => void
  readonly title: ReactNode
}

type SelectProps = {
  readonly onChange: (value: string) => void
  readonly options: Array<{
    readonly label: string
    readonly value: string
  }>
}

const harness = vi.hoisted(() => ({
  dialogProps: undefined as DialogProps | undefined,
  provider: 'firstParty',
  selectProps: undefined as SelectProps | undefined,
}))

vi.mock('../../../src/utils/model/providers.js', () => ({
  getAPIProvider: () => harness.provider,
}))

vi.mock('../../../src/tui/components/CustomSelect/select.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    Select: (props: SelectProps) => {
      harness.selectProps = props

      return ReactActual.createElement(
        'ink-text',
        null,
        props.options.map(option => option.label).join('\n'),
      )
    },
  }
})

vi.mock('../../../src/tui/components/design-system/Dialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    Dialog: (props: DialogProps) => {
      harness.dialogProps = props

      return ReactActual.createElement(
        'ink-box',
        { flexDirection: 'column' },
        ReactActual.createElement('ink-text', null, props.title),
        props.children,
      )
    },
  }
})

describe('CostThresholdDialog coverage swarm row 119', () => {
  beforeEach(() => {
    harness.dialogProps = undefined
    harness.provider = 'firstParty'
    harness.selectProps = undefined
  })

  test.each([
    ['firstParty', 'provider API'],
    ['openai', 'provider-compatible API'],
    ['gemini', 'Gemini API'],
    ['github', 'GitHub Copilot API'],
    ['mistral', 'Mistral API'],
    ['nvidia-nim', 'NVIDIA NIM API'],
    ['minimax', 'MiniMax API'],
    ['agenc', 'AgenC API'],
    ['xai', 'xAI API'],
    ['unexpected-provider', 'API'],
  ])('renders the %s provider cost threshold copy', async (provider, label) => {
    harness.provider = provider

    const output = await renderToString(
      <CostThresholdDialog onDone={() => {}} />,
      { columns: 120 },
    )

    expect(harness.dialogProps?.title).toBe(
      `You've spent $5 on the ${label} this session.`,
    )
    expect(output).toContain(
      `You've spent $5 on the ${label} this session.`,
    )
    expect(output).toContain('Learn more about how to monitor your spending:')
    expect(output).toContain('https://agenc.tech/docs/costs')
    expect(output).toContain('Got it, thanks!')
  })

  test('forwards dismiss actions through onDone', async () => {
    const onDone = vi.fn()

    await renderToString(<CostThresholdDialog onDone={onDone} />, {
      columns: 120,
    })

    expect(harness.dialogProps?.onCancel).toBe(onDone)
    expect(harness.selectProps?.options).toEqual([
      {
        label: 'Got it, thanks!',
        value: 'ok',
      },
    ])
    expect(harness.selectProps?.onChange).toBe(onDone)

    harness.dialogProps?.onCancel()
    harness.selectProps?.onChange('ok')

    expect(onDone).toHaveBeenCalledTimes(2)
  })
})
