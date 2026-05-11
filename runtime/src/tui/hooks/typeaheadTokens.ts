/**
 * Pure regex-driven token extractors for the typeahead picker.
 *
 * Extracted from useTypeahead.tsx so the unit-testable behavior (the
 * @-token boundary rules) can be exercised without dragging the hook's
 * deep React + TUI import graph through vitest. The hook re-exports
 * `extractCompletionToken` so existing call sites keep working.
 */

// Unicode-aware character class for file path tokens:
// \p{L} = letters (CJK, Latin, Cyrillic, etc.)
// \p{N} = numbers (incl. fullwidth)
// \p{M} = combining marks (macOS NFD accents, Devanagari vowel signs)
//
// Unquoted `@` paths additionally allow a single ASCII space provided the
// next character is a valid path char. That preserves `@/tmp/with spaces/foo`
// without consuming whitespace at the natural end of an English sentence.
// Quoted paths (`@"..."`) remain the unambiguous form for arbitrary strings.
export const AT_TOKEN_HEAD_RE =
  /^@(?:[\p{L}\p{N}\p{M}_\-./\\()[\]~:]| (?=[\p{L}\p{N}\p{M}_\-./\\()[\]~:]))*/u;
export const PATH_CHAR_HEAD_RE =
  /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u;
// Used only to extend an @-token across the cursor; accepts the same
// space-followed-by-path-char escape as AT_TOKEN_HEAD_RE so the cursor
// can sit mid-path without the trailing half being dropped.
export const AT_PATH_CHAR_HEAD_RE =
  /^(?:[\p{L}\p{N}\p{M}_\-./\\()[\]~:]| (?=[\p{L}\p{N}\p{M}_\-./\\()[\]~:]))+/u;
export const TOKEN_WITH_AT_RE =
  /(@(?:[\p{L}\p{N}\p{M}_\-./\\()[\]~:]| (?=[\p{L}\p{N}\p{M}_\-./\\()[\]~:]))*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u;
export const TOKEN_WITHOUT_AT_RE =
  /[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+$/u;
export const HAS_AT_SYMBOL_RE =
  /(^|\s)@((?:[\p{L}\p{N}\p{M}_\-./\\()[\]~:]| (?=[\p{L}\p{N}\p{M}_\-./\\()[\]~:]))*|"[^"]*"?)$/u;
export const HASH_CHANNEL_RE =
  /(^|\s)#([a-z0-9][a-z0-9_-]*)$/;

export type CompletionToken = {
  token: string;
  startPos: number;
  isQuoted?: boolean;
};

/**
 * Extract a completable token at the cursor position.
 *
 * @param text          The input text.
 * @param cursorPos     The cursor position (character offset into `text`).
 * @param includeAtSymbol  When true, recognize `@…` and `@"…"` tokens.
 * @returns The completable token plus its start position, or null when the
 *          cursor is not inside any completable token.
 */
export function extractCompletionToken(
  text: string,
  cursorPos: number,
  includeAtSymbol = false,
): CompletionToken | null {
  if (!text) return null;

  const textBeforeCursor = text.substring(0, cursorPos);

  // Check for quoted @ mention first (e.g., @"my file with spaces")
  if (includeAtSymbol) {
    const quotedAtRegex = /@"([^"]*)"?$/;
    const quotedMatch = textBeforeCursor.match(quotedAtRegex);
    if (quotedMatch && quotedMatch.index !== undefined) {
      // Include any remaining quoted content after cursor until closing quote or end
      const textAfterCursor = text.substring(cursorPos);
      const afterQuotedMatch = textAfterCursor.match(/^[^"]*"?/);
      const quotedSuffix = afterQuotedMatch ? afterQuotedMatch[0] : '';
      return {
        token: quotedMatch[0] + quotedSuffix,
        startPos: quotedMatch.index,
        isQuoted: true,
      };
    }
  }

  // Fast path for @ tokens: use lastIndexOf to avoid expensive $ anchor scan.
  if (includeAtSymbol) {
    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(textBeforeCursor[atIdx - 1]!))) {
      const fromAt = textBeforeCursor.substring(atIdx);
      const atHeadMatch = fromAt.match(AT_TOKEN_HEAD_RE);
      if (atHeadMatch && atHeadMatch[0].length === fromAt.length) {
        const textAfterCursor = text.substring(cursorPos);
        // Extend across the cursor using the same space-tolerant class so
        // tokens like `@/path with spaces/<cursor>foo` round-trip cleanly.
        const afterMatch = textAfterCursor.match(AT_PATH_CHAR_HEAD_RE);
        const tokenSuffix = afterMatch ? afterMatch[0] : '';
        return {
          token: atHeadMatch[0] + tokenSuffix,
          startPos: atIdx,
          isQuoted: false,
        };
      }
    }
  }

  // Non-@ token or cursor outside @ token — use $ anchor on (short) tail
  const tokenRegex = includeAtSymbol ? TOKEN_WITH_AT_RE : TOKEN_WITHOUT_AT_RE;
  const match = textBeforeCursor.match(tokenRegex);
  if (!match || match.index === undefined) {
    return null;
  }

  // Check if cursor is in the MIDDLE of a token (more word characters after cursor).
  // If so, extend the token to include all characters until whitespace or end of string.
  const textAfterCursor = text.substring(cursorPos);
  const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE);
  const tokenSuffix = afterMatch ? afterMatch[0] : '';
  return {
    token: match[0] + tokenSuffix,
    startPos: match.index,
    isQuoted: false,
  };
}

/**
 * Extract the search-token form of a completion token (strip `@` / quotes).
 */
export function extractSearchToken(completionToken: {
  token: string;
  isQuoted?: boolean;
}): string {
  if (completionToken.isQuoted) {
    return completionToken.token.slice(2).replace(/"$/, '');
  }
  if (completionToken.token.startsWith('@')) {
    return completionToken.token.substring(1);
  }
  return completionToken.token;
}
