import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { ConfigStore } from '../../src/config/store.js'
import {
  loadMarkdownFilesForSubdir,
  loadMarkdownFilesForSubdirFresh,
} from '../../src/utils/markdownConfigLoader.js'
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from '../../src/utils/settings/canonicalAuthority.js'

const temporaryRoots: string[] = []

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenc-markdown-${label}-`))
  temporaryRoots.push(root)
  return root
}

async function createAuthority(
  home: string,
  workspace: string,
  managedRoot?: string,
): Promise<ConfigStore> {
  mkdirSync(home, { recursive: true })
  const store = new ConfigStore({
    home,
    cwd: workspace,
    projectRoot: workspace,
    projectTrusted: false,
    env: {},
    ...(managedRoot === undefined
      ? {}
      : { managedConfigPath: join(managedRoot, 'config.toml') }),
    loader: async () => ({ configVersion: 2 }),
  })
  await store.reload()
  return store
}

function writeManagedAgent(root: string, prompt: string): void {
  const agents = join(root, '.agenc', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(
    join(agents, 'managed-snapshot.md'),
    `---\nname: managed-snapshot\ndescription: Managed snapshot role\n---\n${prompt}\n`,
  )
}

function writeAgent(home: string, prompt: string): void {
  const agents = join(home, 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(
    join(agents, 'snapshot.md'),
    `---\nname: snapshot\ndescription: Snapshot role\n---\n${prompt}\n`,
  )
}

function prompt(
  files: Awaited<ReturnType<typeof loadMarkdownFilesForSubdir>>,
  name = 'snapshot',
): string {
  return files.find(file => file.frontmatter.name === name)?.content.trim() ?? ''
}

afterEach(() => {
  resetCanonicalSettingsAuthorityForTesting()
  loadMarkdownFilesForSubdir.cache.clear()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('markdown discovery authority', () => {
  test('loads user markdown from each ConfigStore home without process environment fallback', async () => {
    const workspace = temporaryRoot('workspace')
    const homeA = temporaryRoot('home-a')
    const homeB = temporaryRoot('home-b')
    writeAgent(homeA, 'Home A prompt.')
    writeAgent(homeB, 'Home B prompt.')
    const authorityA = await createAuthority(homeA, workspace)
    const authorityB = await createAuthority(homeB, workspace)

    const filesA = await runWithCanonicalSettingsAuthority(authorityA, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )
    const filesB = await runWithCanonicalSettingsAuthority(authorityB, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )

    expect(prompt(filesA)).toBe('Home A prompt.')
    expect(prompt(filesB)).toBe('Home B prompt.')
  })

  test('isolates same-home snapshots and clears only the active ConfigStore partition', async () => {
    const workspace = temporaryRoot('shared-workspace')
    const home = temporaryRoot('shared-home')
    writeAgent(home, 'Snapshot A.')
    const authorityA = await createAuthority(home, workspace)
    const authorityB = await createAuthority(home, workspace)

    const filesA = await runWithCanonicalSettingsAuthority(authorityA, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )
    writeAgent(home, 'Snapshot B.')
    const filesB = await runWithCanonicalSettingsAuthority(authorityB, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )
    const filesAAgain = await runWithCanonicalSettingsAuthority(authorityA, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )

    expect(prompt(filesA)).toBe('Snapshot A.')
    expect(prompt(filesB)).toBe('Snapshot B.')
    expect(prompt(filesAAgain)).toBe('Snapshot A.')

    runWithCanonicalSettingsAuthority(authorityA, () =>
      loadMarkdownFilesForSubdir.cache.clear(),
    )
    writeAgent(home, 'Snapshot C.')
    const filesAAfterClear = await runWithCanonicalSettingsAuthority(
      authorityA,
      () => loadMarkdownFilesForSubdir('agents', workspace),
    )
    const filesBAfterClear = await runWithCanonicalSettingsAuthority(
      authorityB,
      () => loadMarkdownFilesForSubdir('agents', workspace),
    )

    expect(prompt(filesAAfterClear)).toBe('Snapshot C.')
    expect(prompt(filesBAfterClear)).toBe('Snapshot B.')
  })

  test('binds managed Markdown discovery to each ConfigStore root', async () => {
    const workspace = temporaryRoot('managed-workspace')
    const home = temporaryRoot('managed-home')
    const managedA = temporaryRoot('managed-a')
    const managedB = temporaryRoot('managed-b')
    writeManagedAgent(managedA, 'Managed A prompt.')
    writeManagedAgent(managedB, 'Managed B prompt.')
    const authorityA = await createAuthority(home, workspace, managedA)
    const authorityB = await createAuthority(home, workspace, managedB)

    const filesA = await runWithCanonicalSettingsAuthority(authorityA, () =>
      loadMarkdownFilesForSubdir('agents', workspace),
    )
    const filesB = await runWithCanonicalSettingsAuthority(authorityB, () =>
      loadMarkdownFilesForSubdirFresh('agents', workspace),
    )

    expect(prompt(filesA, 'managed-snapshot')).toBe('Managed A prompt.')
    expect(prompt(filesB, 'managed-snapshot')).toBe('Managed B prompt.')
    expect(
      filesA.find(file => file.frontmatter.name === 'managed-snapshot')?.source,
    ).toBe('policySettings')
    expect(
      filesB.find(file => file.frontmatter.name === 'managed-snapshot')?.source,
    ).toBe('policySettings')
  })
})
