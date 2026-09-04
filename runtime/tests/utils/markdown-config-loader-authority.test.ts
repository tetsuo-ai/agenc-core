import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { ConfigStore } from '../../src/config/store.js'
import { selectPinnedRipgrepPath } from '../../src/tools/system/pinned-ripgrep.js'
import {
  loadMarkdownFilesForSubdir,
  loadMarkdownFilesForSubdirFresh,
} from '../../src/utils/markdownConfigLoader.js'
import { getRipgrepStatus } from '../../src/utils/ripgrep.js'
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from '../../src/utils/settings/canonicalAuthority.js'

const pinnedRipgrepPath = selectPinnedRipgrepPath()
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

  test('still finds markdown when the search binary cannot run', async () => {
    // ripGrep reports an unavailable binary with code "ENOENT", which errno
    // alone cannot tell apart from "the directory is gone", so the loader
    // swallowed it and every markdown-defined agent, command and hook
    // silently vanished wherever ripgrep could not start. CI is exactly such
    // a machine: with `rg` off PATH this reproduced as a catalog holding only
    // the five built-in agents. The native walk is the documented fallback.
    const workspace = temporaryRoot('workspace-no-rg')
    const home = temporaryRoot('home-no-rg')
    writeAgent(home, 'Found without ripgrep.')
    const authority = await createAuthority(home, workspace)

    const previousBuiltin = process.env.USE_BUILTIN_RIPGREP
    const previousPath = process.env.PATH
    process.env.USE_BUILTIN_RIPGREP = 'false'
    // A PATH with no `rg` on it, which is what makes ripGrep reject.
    process.env.PATH = temporaryRoot('empty-bin')
    try {
      const files = await runWithCanonicalSettingsAuthority(authority, () =>
        loadMarkdownFilesForSubdirFresh('agents', workspace),
      )
      expect(prompt(files)).toBe('Found without ripgrep.')
    } finally {
      if (previousBuiltin === undefined) delete process.env.USE_BUILTIN_RIPGREP
      else process.env.USE_BUILTIN_RIPGREP = previousBuiltin
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  test.skipIf(pinnedRipgrepPath === undefined)(
    'packaged @vscode/ripgrep supports markdown discovery without system rg',
    async () => {
      const pinned = pinnedRipgrepPath!

      const workspace = temporaryRoot('workspace-packaged-rg')
      const home = temporaryRoot('home-packaged-rg')
      writeAgent(home, 'Found via packaged ripgrep.')
      const authority = await createAuthority(home, workspace)

      const previousPath = process.env.PATH
      const previousNative = process.env.AGENC_USE_NATIVE_FILE_SEARCH
      const emptyBin = temporaryRoot('empty-bin-packaged')
      process.env.PATH = emptyBin
      delete process.env.AGENC_USE_NATIVE_FILE_SEARCH
      try {
        const status = getRipgrepStatus({
          environment: { ...process.env, PATH: emptyBin },
          systemExecutablePath: 'rg',
        })
        expect(status.mode).toBe('builtin')
        expect(status.path).toBe(pinned)

        const files = await runWithCanonicalSettingsAuthority(authority, () =>
          loadMarkdownFilesForSubdirFresh('agents', workspace),
        )
        expect(prompt(files)).toBe('Found via packaged ripgrep.')
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        if (previousNative === undefined) {
          delete process.env.AGENC_USE_NATIVE_FILE_SEARCH
        } else {
          process.env.AGENC_USE_NATIVE_FILE_SEARCH = previousNative
        }
      }
    },
  )

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
