import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ToolUseContext } from '../tools/Tool.js'
import { getBundledSkills } from './bundledSkills.js'

test('bundled agenc-marketplace-kit-installer skill registers with the safe install runbook', async () => {
  const skill = getBundledSkills().find(
    (command) => command.name === 'agenc-marketplace-kit-installer',
  )
  assert.ok(skill, 'installer skill is registered as a bundled skill')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.userInvocable, true)
  assert.equal(skill.isHidden, false)
  assert.equal(skill.type, 'prompt')

  const blocks = await skill.getPromptForCommand('', {} as ToolUseContext)
  const text = blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')

  assert.match(
    text,
    /curl -fsSL https:\/\/marketplace\.agenc\.tech\/install\.sh \| sh/,
    'carries the macOS/Linux one-liner',
  )
  assert.match(text, /install\.ps1/, 'carries the Windows installer')
  assert.match(text, /SHA-256/, 'states integrity verification')
  assert.match(
    text,
    /never require GitHub auth/,
    'public downloads must not request GitHub credentials',
  )
  assert.match(
    text,
    /ONE plain yes\/no question/,
    'asks a single confirmation before local changes',
  )
  assert.match(
    text,
    /marketplace\.agenc\.tech\/agents\.txt/,
    'hands off to the official operating runbook',
  )
  assert.match(
    text,
    /policy init-\*/,
    'forbids hand-authoring signer policy JSON',
  )
})
