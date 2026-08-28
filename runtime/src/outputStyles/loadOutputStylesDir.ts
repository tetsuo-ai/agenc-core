import { basename } from 'path'
import type { OutputStyleConfig } from '../constants/outputStyles.js'
import { logForDebugging } from 'src/utils/debug.js'
import { coerceDescriptionToString } from '../utils/frontmatterParser.js'
import { logError } from '../utils/log.js'
import {
  extractDescriptionFromMarkdown,
  loadMarkdownFilesForSubdir,
} from '../utils/markdownConfigLoader.js'

/**
 * Loads managed, user, and repository output-style Markdown sources.
 *
 * Each filename becomes a style name, and the file content becomes the style prompt.
 * The frontmatter provides name and description.
 *
 * Structure:
 * - Managed <managed root>/.agenc/output-styles/*.md -> managed styles
 * - User $AGENC_HOME/output-styles/*.md -> user styles
 * - Repository <ancestor>/.agenc/output-styles/*.md -> untrusted content;
 *   getAllOutputStyles excludes it from system-prompt authority
 *
 * @param cwd Current working directory for project directory traversal
 */
export async function getOutputStyleDirStyles(
  cwd: string,
): Promise<OutputStyleConfig[]> {
    try {
      const markdownFiles = await loadMarkdownFilesForSubdir(
        'output-styles',
        cwd,
      )

      const styles = markdownFiles
        .map(({ filePath, frontmatter, content, source }) => {
          try {
            const fileName = basename(filePath)
            const styleName = fileName.replace(/\.md$/, '')

            // Get style configuration from frontmatter
            const name = (frontmatter['name'] || styleName) as string
            const description =
              coerceDescriptionToString(
                frontmatter['description'],
                styleName,
              ) ??
              extractDescriptionFromMarkdown(
                content,
                `Custom ${styleName} output style`,
              )

            // Parse keep-coding-instructions flag (supports both boolean and string values)
            const keepCodingInstructionsRaw =
              frontmatter['keep-coding-instructions']
            const keepCodingInstructions =
              keepCodingInstructionsRaw === true ||
              keepCodingInstructionsRaw === 'true'
                ? true
                : keepCodingInstructionsRaw === false ||
                    keepCodingInstructionsRaw === 'false'
                  ? false
                  : undefined

            // Warn if force-for-plugin is set on non-plugin output style
            if (frontmatter['force-for-plugin'] !== undefined) {
              logForDebugging(
                `Output style "${name}" has force-for-plugin set, but this option only applies to plugin output styles. Ignoring.`,
                { level: 'warn' },
              )
            }

            return {
              name,
              description,
              prompt: content.trim(),
              source,
              keepCodingInstructions,
            }
          } catch (error) {
            logError(error)
            return null
          }
        })
        .filter(style => style !== null)

      return styles
    } catch (error) {
      logError(error)
      return []
    }
}
