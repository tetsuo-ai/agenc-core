import React from 'react'
import { describe, expect, test } from 'vitest'

import { UserBashOutputMessage } from '../../../src/tui/message-renderers/UserBashOutputMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

describe('UserBashOutputMessage coverage swarm row 169', () => {
  test('renders raw stdout and stderr when stdout has no persisted-output tag', async () => {
    const output = await renderToString(
      <UserBashOutputMessage
        content={[
          '<bash-stdout>',
          'plain stdout',
          '</bash-stdout>',
          '<bash-stderr>',
          'plain stderr',
          '</bash-stderr>',
        ].join('\n')}
        verbose={true}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain('plain stdout')
    expect(output).toContain('plain stderr')
    expect(output).not.toContain('(No output)')
  })

  test('uses the persisted stdout preview instead of the raw output envelope', async () => {
    const output = await renderToString(
      <UserBashOutputMessage
        content={[
          '<bash-stdout>',
          'raw output that should be hidden',
          '<persisted-output>',
          'persisted preview',
          '</persisted-output>',
          '</bash-stdout>',
        ].join('\n')}
        verbose={true}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain('persisted preview')
    expect(output).not.toContain('raw output that should be hidden')
    expect(output).not.toContain('<persisted-output>')
  })

  test('shows the empty-output fallback when bash output tags are absent', async () => {
    const output = await renderToString(
      <UserBashOutputMessage content="legacy untagged shell text" />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain('(No output)')
    expect(output).not.toContain('legacy untagged shell text')
  })
})
