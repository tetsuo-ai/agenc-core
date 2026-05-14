import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'
import { PermissionRuleDescription } from './PermissionRuleDescription.js'

describe('PermissionRuleDescription', () => {
  test('keeps Bash scoped rule descriptions', async () => {
    const output = await renderToString(
      <PermissionRuleDescription
        ruleValue={{ toolName: 'Bash', ruleContent: 'git status:*' }}
      />,
      80,
    )

    expect(output).toContain('Any Bash command starting with git status')
  })

  test('describes unscoped non-Bash tool rules', async () => {
    const output = await renderToString(
      <PermissionRuleDescription ruleValue={{ toolName: 'Read' }} />,
      80,
    )

    expect(output).toContain('Any use of the Read tool')
  })

  test('describes WebFetch domain rules', async () => {
    const output = await renderToString(
      <PermissionRuleDescription
        ruleValue={{
          toolName: 'WebFetch',
          ruleContent: 'domain:example.com',
        }}
      />,
      80,
    )

    expect(output).toContain('Any WebFetch request to example.com')
  })

  test('describes Skill prefix rules', async () => {
    const output = await renderToString(
      <PermissionRuleDescription
        ruleValue={{ toolName: 'Skill', ruleContent: 'review:*' }}
      />,
      80,
    )

    expect(output).toContain('Any Skill command starting with review')
  })

  test('describes generic scoped non-Bash rules instead of rendering null', async () => {
    const output = await renderToString(
      <PermissionRuleDescription
        ruleValue={{ toolName: 'Read', ruleContent: 'src/**' }}
      />,
      80,
    )

    expect(output).toContain('The Read rule src/**')
  })
})
