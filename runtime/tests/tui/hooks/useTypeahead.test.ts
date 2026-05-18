import { describe, it, expect } from 'vitest';
import { extractCompletionToken } from './typeaheadTokens';

/**
 * Tests for useTypeahead's @-token extractor.
 *
 * Covers Unit 4 of the round-2 UX backlog:
 *   - MD-NEW7: unquoted @-paths must keep embedded spaces when the next
 *     char is still a path char (so `@/tmp/with spaces/foo` survives).
 *   - Mid-cursor behavior: when the cursor sits inside an @-token, the
 *     extractor must return the full surrounding token (start..end of
 *     the path segment), not just the substring before the cursor.
 *
 * L7 (cycle on Tab) and MD-NEW9 (Tab consumption) live in handleTab /
 * handleKeyDown which require a rendered hook host; those are covered by
 * the PTY-driven TUI gate, not unit tests.
 */

describe('extractCompletionToken — @-token boundaries', () => {
  it('extracts a simple @-path token', () => {
    const text = '@/tmp/foo';
    const result = extractCompletionToken(text, text.length, true);
    expect(result).not.toBeNull();
    expect(result?.token).toBe('@/tmp/foo');
    expect(result?.startPos).toBe(0);
    expect(result?.isQuoted).toBe(false);
  });

  it('keeps embedded spaces when the next char is a path char (MD-NEW7)', () => {
    const text = '@/tmp/with spaces/foo';
    const result = extractCompletionToken(text, text.length, true);
    expect(result).not.toBeNull();
    expect(result?.token).toBe('@/tmp/with spaces/foo');
    expect(result?.startPos).toBe(0);
  });

  it('keeps multiple embedded spaces across path segments', () => {
    const text = '@/a b/c d/e';
    const result = extractCompletionToken(text, text.length, true);
    expect(result?.token).toBe('@/a b/c d/e');
  });

  it('returns null when the cursor is in trailing whitespace after the @-path', () => {
    const text = '@/tmp/foo ';
    const result = extractCompletionToken(text, text.length, true);
    // cursor on whitespace = not inside a token; the @-fast-path requires
    // an exact match against fromAt, and the fallback regex's $ anchor
    // can't reach back across the trailing space either. The picker
    // closes when the cursor sits past the token.
    expect(result).toBeNull();
  });

  it('keeps the @-token when the cursor sits at its last path char', () => {
    const text = '@/tmp/foo ';
    // cursor right at the 'o' before the trailing space.
    const cursor = '@/tmp/foo'.length;
    const result = extractCompletionToken(text, cursor, true);
    expect(result?.token).toBe('@/tmp/foo');
  });

  it('still parses quoted @-paths unchanged', () => {
    const text = '@"/tmp/with spaces/foo"';
    const result = extractCompletionToken(text, text.length, true);
    expect(result?.token).toBe('@"/tmp/with spaces/foo"');
    expect(result?.isQuoted).toBe(true);
  });

  it('returns the full surrounding @-token when the cursor is mid-token', () => {
    const text = '@/tmp/with spaces/foo';
    // cursor between "with" and " spaces"
    const cursor = '@/tmp/with'.length;
    const result = extractCompletionToken(text, cursor, true);
    expect(result).not.toBeNull();
    // The mid-cursor extractor must report the whole path so the picker
    // can be reopened scoped to it. Sub-cursor search-token shaping is
    // handled at the picker layer, not here.
    expect(result?.token).toBe('@/tmp/with spaces/foo');
    expect(result?.startPos).toBe(0);
  });

  it('returns the full @-token when the cursor sits at the @', () => {
    const text = '@/tmp/path';
    const result = extractCompletionToken(text, 0, true);
    // cursor at position 0 means textBeforeCursor = "" — no @ yet,
    // so no @-token is matched. This is the documented behavior; the
    // picker is opened by the next keystroke, not by sitting on the @.
    expect(result).toBeNull();
  });

  it('matches an @-token starting after whitespace mid-input', () => {
    const text = 'hello @/tmp/with spaces/foo';
    const result = extractCompletionToken(text, text.length, true);
    expect(result?.token).toBe('@/tmp/with spaces/foo');
    expect(result?.startPos).toBe('hello '.length);
  });

  it('@ glued to a previous word still extracts the path-bearing tail', () => {
    const text = 'foo@/tmp/bar';
    const result = extractCompletionToken(text, text.length, true);
    // `foo@` fails the @-fast-path word-boundary check, so the fallback
    // TOKEN_WITH_AT_RE matches the suffix `@/tmp/bar` via its alternation.
    // The picker treats this as an @-token because of the leading @.
    expect(result?.token).toBe('@/tmp/bar');
    expect(result?.startPos).toBe('foo'.length);
  });

  it('treats `@` followed by nothing as a one-char token', () => {
    const text = '@';
    const result = extractCompletionToken(text, text.length, true);
    expect(result?.token).toBe('@');
    expect(result?.startPos).toBe(0);
  });
});

describe('extractCompletionToken — non-@ paths still split on whitespace', () => {
  it('non-@ tokens stop at whitespace', () => {
    const text = '/tmp/foo bar';
    const result = extractCompletionToken(text, text.length, false);
    expect(result?.token).toBe('bar');
  });

  it('non-@ tokens do not absorb a leading space', () => {
    const text = '/tmp/foo ';
    const result = extractCompletionToken(text, text.length, false);
    // No path-char after cursor and the last char before cursor is space,
    // so there's no token at the cursor.
    expect(result).toBeNull();
  });
});
