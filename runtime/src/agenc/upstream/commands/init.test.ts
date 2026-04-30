import { afterEach, expect, mock, test } from 'bun:test'

const originalAgenCCodeNewInit = process.env.AGENC_NEW_INIT

async function importInitCommand() {
  return (await import(`./init.ts?ts=${Date.now()}-${Math.random()}`)).default
}

afterEach(() => {
  mock.restore()

  if (originalAgenCCodeNewInit === undefined) {
    delete process.env.AGENC_NEW_INIT
  } else {
    process.env.AGENC_NEW_INIT = originalAgenCCodeNewInit
  }
})

test('NEW_INIT prompt preserves existing root AGENC.md by default', async () => {
  process.env.AGENC_NEW_INIT = '1'

  mock.module('../projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))
  mock.module('./initMode.js', () => ({
    isNewInitEnabled: () => true,
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()

  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.type).toBe('text')
  expect(String(blocks[0]?.text)).toContain(
    'checked-in root `AGENC.md` and does NOT already have a root `AGENTS.md`',
  )
  expect(String(blocks[0]?.text)).toContain(
    'do NOT silently create a second root instruction file',
  )
  expect(String(blocks[0]?.text)).toContain(
    'update the existing root `AGENC.md` in place by default',
  )
})
