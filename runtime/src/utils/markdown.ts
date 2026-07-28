import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../tui/components/design-system/color.js'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth } from '../tui/ink/stringWidth.js'
import { supportsHyperlinks } from '../tui/ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import type { Theme as CliHighlightTheme } from 'cli-highlight'
import { logForDebugging } from 'src/utils/debug.js'
import { createHyperlink } from './hyperlink.js'
import { stripPromptXMLTags } from './messages.js'
import type { ThemeName } from './theme.js'

// Use \n unconditionally — os.EOL is \r\n on Windows, and the extra \r
// breaks the character-to-segment mapping in applyStylesToWrappedText,
// causing styled text to shift right.
const EOL = '\n'

// The default dark TUI is intentionally monochrome, but cli-highlight ships
// its own ANSI palette and therefore bypasses AgenC's theme tokens. A complete
// token map is required: any missing key falls back to cli-highlight's colored
// default theme. Hierarchy here comes from weight and luminance only.
const codeWhite = (part: string): string => chalk.white(part)
const codeStrong = (part: string): string => chalk.white.bold(part)
const codeMuted = (part: string): string => chalk.rgb(150, 150, 150)(part)
const codeEmphasis = (part: string): string => chalk.white.italic(part)
const codeUnderline = (part: string): string => chalk.white.underline(part)

const MONOCHROME_CODE_THEME = {
  default: codeWhite,
  keyword: codeStrong,
  built_in: codeStrong,
  type: codeStrong,
  literal: codeStrong,
  number: codeWhite,
  regexp: codeWhite,
  string: codeWhite,
  subst: codeWhite,
  symbol: codeStrong,
  class: codeStrong,
  function: codeStrong,
  title: codeStrong,
  params: codeWhite,
  comment: codeMuted,
  doctag: codeMuted,
  meta: codeStrong,
  'meta-keyword': codeStrong,
  'meta-string': codeWhite,
  section: codeUnderline,
  tag: codeStrong,
  name: codeStrong,
  'builtin-name': codeStrong,
  attr: codeWhite,
  attribute: codeWhite,
  variable: codeWhite,
  bullet: codeStrong,
  code: codeWhite,
  emphasis: codeEmphasis,
  strong: codeStrong,
  formula: codeWhite,
  link: codeUnderline,
  quote: codeMuted,
  'selector-tag': codeStrong,
  'selector-id': codeStrong,
  'selector-class': codeStrong,
  'selector-attr': codeWhite,
  'selector-pseudo': codeStrong,
  'template-tag': codeStrong,
  'template-variable': codeWhite,
  addition: codeStrong,
  deletion: codeMuted,
} satisfies CliHighlightTheme

// CommonMark soft line breaks inside a paragraph render like ordinary spaces
// in HTML. Preserve explicit hard breaks (`br` tokens) separately, but do not
// turn model-authored source wrapping into cramped terminal rows.
function normalizeSoftLineBreaks(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  // Disable strikethrough parsing - the model often uses ~ for "approximate"
  // (e.g., ~100) and rarely intends actual strikethrough formatting
  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
    },
  })
}

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(_ => formatToken(_, theme, 0, null, null, highlight))
    .join('')
    .trim()
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // Prefix each line with a dim vertical bar. Keep text italic but at
      // normal brightness — chalk.dim is nearly invisible on dark themes.
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map(line =>
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line,
        )
        .join(EOL)
    }
    case 'code': {
      if (!highlight) {
        return token.text + EOL
      }
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      return highlight.highlight(token.text, {
        language,
        ...(theme === 'dark' ? { theme: MONOCHROME_CODE_THEME } : {}),
      }) + EOL
    }
    case 'codespan': {
      // inline code
      return color('permission', theme)(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'heading':
      // Style-only headings: the terminal shows emphasis, not raw markdown
      // markers — no literal '#' prefix on any depth (UX request).
      switch (token.depth) {
        case 1: // h1
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // h2
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // h3+
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'hr':
      return '---'
    case 'image':
      return token.href
    case 'link': {
      // Prevent mailto links from being displayed as clickable links
      if (token.href.startsWith('mailto:')) {
        // Extract email from mailto: link and display as plain text
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // Extract display text from the link's child tokens
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // If the link has meaningful display text (different from the URL),
      // show it as a clickable hyperlink. In terminals that support OSC 8,
      // users see the text and can hover/click to see the URL.
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // When the display text matches the URL (or is empty), just show the URL
      return createHyperlink(token.href)
    }
    case 'list': {
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            token.ordered ? token.start + index : null,
            token,
            highlight,
          ),
        )
        .join('')
    }
    case 'list_item':
      return (token.tokens ?? [])
        .map(
          _ =>
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, token, highlight)}`,
        )
        .join('')
    case 'paragraph':
      return (
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, null, highlight))
          .join('') + EOL
      )
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // Already inside a markdown link — the link handler will wrap this
        // in an OSC 8 hyperlink. Linkifying here would nest a second OSC 8
        // sequence, and terminals honor the innermost one, overriding the
        // link's actual href.
        return normalizeSoftLineBreaks(token.text)
      }
      if (parent?.type === 'list_item') {
        return `${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} ${token.tokens ? token.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(normalizeSoftLineBreaks(token.text))}${EOL}`
      }
      return linkifyIssueReferences(normalizeSoftLineBreaks(token.text))
    case 'table': {
      const tableToken = token as Tokens.Table

      // Helper function to get the text content that will be displayed (after stripAnsi)
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? '',
        )
      }

      // Determine column widths based on displayed content (without formatting)
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3) // Minimum width of 3
      })

      // Format header row
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput +=
          padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // Add separator row
      tableOutput += '|'
      columnWidths.forEach(width => {
        // Always use dashes, don't show alignment colons in the output
        const separator = '-'.repeat(width + 2) // +2 for spaces on each side
        tableOutput += separator + '|'
      })
      tableOutput += EOL

      // Format data rows
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens
              ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
              .join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput +=
            padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown escape: \) → ), \\ → \, etc.
      return token.text
    case 'def':
    case 'del':
    case 'html':
      // These token types are not rendered
      return ''
  }
  return ''
}

// Matches owner/repo#NNN style GitHub issue/PR references. The qualified form
// is unambiguous — bare #NNN was removed because it guessed the current repo
// and was wrong whenever the assistant discussed a different one.
// Owner segment disallows dots (GitHub usernames are alphanumerics + hyphens
// only) so hostnames like docs.github.io/guide#42 don't false-positive. Repo
// segment allows dots (e.g. cc.kurs.web). Lookbehind is avoided — it defeats
// YARR JIT in JSC.
const ISSUE_REF_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * Replaces owner/repo#123 references with clickable hyperlinks to GitHub.
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${num}`,
        `${repo}#${num}`,
      ),
  )
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
 * visible width of `content` (caller computes this, e.g. via stringWidth on
 * stripAnsi'd text, so ANSI codes in `content` don't affect padding).
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
