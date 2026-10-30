import { afterEach, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectExtensionInstallationPortable } from '../../../src/utils/agencInChrome/setupPortable.js'

const roots: string[] = []
const extensionId = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('finds an extension in a numbered profile after a missing browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-profiles-'))
  roots.push(root)
  await writeFile(join(root, 'Profile 1'), 'not a directory')
  await mkdir(join(root, 'Default'))
  await mkdir(join(root, 'Profile 2', 'Extensions', extensionId), { recursive: true })

  await expect(detectExtensionInstallationPortable([
    { browser: 'chrome', path: join(root, 'missing') },
    { browser: 'brave', path: root },
  ])).resolves.toEqual({ isInstalled: true, browser: 'brave' })
})

test('ignores extension directories outside browser profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-profiles-'))
  roots.push(root)
  await mkdir(join(root, 'Cache', 'Extensions', extensionId), { recursive: true })

  await expect(detectExtensionInstallationPortable([
    { browser: 'chrome', path: root },
  ])).resolves.toEqual({ isInstalled: false, browser: null })
})
