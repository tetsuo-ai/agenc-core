import { join } from 'path'
import { logForDebugging } from 'src/utils/debug.js'
import { getFsImplementation } from '../fsOperations.js'

const SKILL_MD_RE = /^skill\.md$/i

/**
 * Recursively walk a plugin directory, invoking onFile for each .md file.
 *
 * The namespace array tracks the subdirectory path relative to the root
 * (e.g., ['foo', 'bar'] for root/foo/bar/file.md). Callers that don't need
 * namespacing can ignore the second argument.
 *
 * When stopAtSkillDir is true and a directory contains SKILL.md, onFile is
 * called for all .md files in that directory but subdirectories are not
 * scanned — skill directories are leaf containers.
 *
 * Readdir errors are swallowed with a debug log so one bad directory doesn't
 * abort a plugin load. A failing onFile is likewise isolated per-file (logged
 * with the offending file path) so one unreadable/invalid file doesn't abort
 * the rest of its directory or get mislogged as a directory-scan failure.
 */
export async function walkPluginMarkdown(
  rootDir: string,
  onFile: (fullPath: string, namespace: string[]) => Promise<void>,
  opts: { stopAtSkillDir?: boolean; logLabel?: string } = {},
): Promise<void> {
  const fs = getFsImplementation()
  const label = opts.logLabel ?? 'plugin'

  // Isolate a single file's onFile rejection so it doesn't reject the whole
  // directory's Promise.all (dropping sibling files) and surface via the
  // directory catch as a misleading "Failed to scan directory" error.
  const safeOnFile = (p: string, ns: string[]): Promise<void> =>
    onFile(p, ns).catch(err =>
      logForDebugging(`Failed to process ${label} file ${p}: ${err}`, {
        level: 'error',
      }),
    )

  async function scan(dirPath: string, namespace: string[]): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath)

      if (
        opts.stopAtSkillDir &&
        entries.some(e => e.isFile() && SKILL_MD_RE.test(e.name))
      ) {
        // Skill directory: collect .md files here, don't recurse.
        await Promise.all(
          entries.map(entry =>
            entry.isFile() && entry.name.toLowerCase().endsWith('.md')
              ? safeOnFile(join(dirPath, entry.name), namespace)
              : undefined,
          ),
        )
        return
      }

      await Promise.all(
        entries.map(entry => {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            return scan(fullPath, [...namespace, entry.name])
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            return safeOnFile(fullPath, namespace)
          }
          return undefined
        }),
      )
    } catch (error) {
      logForDebugging(
        `Failed to scan ${label} directory ${dirPath}: ${error}`,
        { level: 'error' },
      )
    }
  }

  await scan(rootDir, [])
}
