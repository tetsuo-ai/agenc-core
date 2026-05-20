import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'

describe('UserBashOutputMessage', () => {
  it('renders persisted stdout preview and stderr from tagged bash output', async () => {
    const output = await renderToString(
      <UserBashOutputMessage
        content={
          '<bash-stdout>raw file output <persisted-output>preview line 1\npreview line 2</persisted-output></bash-stdout>' +
          '<bash-stderr>warning line</bash-stderr>'
        }
        verbose={true}
      />,
      100,
    )

    expect(output).toContain('preview line 1')
    expect(output).toContain('preview line 2')
    expect(output).toContain('warning line')
    expect(output).not.toContain('raw file output')
    expect(output).not.toContain('<persisted-output>')
    expect(output).not.toContain('(No output)')
  })
})
