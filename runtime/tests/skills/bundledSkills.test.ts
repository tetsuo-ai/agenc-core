import assert from 'node:assert/strict'
import { test } from 'vitest'

// MACRO is replaced at build time but not in test mode. Bundled skills with
// `files` resolve their extraction directory (MACRO.VERSION) at registration,
// i.e. at module load of bundledSkills.ts — stub before the dynamic import.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/tetsuo-ai/agenc-core/issues',
  PACKAGE_URL: '@tetsuo-ai/agenc',
  NATIVE_PACKAGE_URL: undefined,
}

import type { ToolUseContext } from '../tools/Tool.js'

test('bundled agenc-marketplace-kit-installer skill registers with the safe install runbook', async () => {
  const { getBundledSkills } = await import('./bundledSkills.js')
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

test('the kit installer is unlisted by default and listed once the marketplace is enabled', async () => {
  const { isBundledSkillListed } = await import('./bundledSkills.js')
  const installer = 'agenc-marketplace-kit-installer'

  assert.equal(isBundledSkillListed(installer, undefined), false)
  assert.equal(isBundledSkillListed(installer, {}), false)
  assert.equal(isBundledSkillListed(installer, { protocol: { enabled: false } }), false)
  // Only a real boolean turns it on.
  assert.equal(isBundledSkillListed(installer, { protocol: { enabled: 'true' } }), false)
  assert.equal(isBundledSkillListed(installer, { protocol: 'enabled' }), false)
  assert.equal(
    isBundledSkillListed(installer, {
      protocol: { enabled: true, adapter: 'marketplace-cli' },
    }),
    true,
  )
  // It stays loadable by name: it is registered, only unlisted.
  const { getBundledSkills } = await import('./bundledSkills.js')
  assert.ok(getBundledSkills().some((command) => command.name === installer))
})

test('other bundled skills stay listed regardless of config', async () => {
  const { isBundledSkillListed } = await import('./bundledSkills.js')

  assert.equal(isBundledSkillListed('browser-automation', undefined), true)
  assert.equal(isBundledSkillListed('browser-automation', { protocol: { enabled: false } }), true)
  assert.equal(isBundledSkillListed('not-registered', {}), true)
})

test('registerBundledSkill honours listedByDefault: false and clearBundledSkills forgets it', async () => {
  const { registerBundledSkill, isBundledSkillListed, clearBundledSkills } = await import(
    './bundledSkills.js'
  )
  const definition = {
    description: 'test skill',
    getPromptForCommand: async () => [],
  }
  registerBundledSkill({ ...definition, name: 'test-hidden-skill', listedByDefault: false })
  registerBundledSkill({ ...definition, name: 'test-shown-skill', listedByDefault: true })

  assert.equal(isBundledSkillListed('test-hidden-skill', {}), false)
  assert.equal(isBundledSkillListed('test-shown-skill', {}), true)

  clearBundledSkills()
  assert.equal(isBundledSkillListed('test-hidden-skill', {}), true)
})
