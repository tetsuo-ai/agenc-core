import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
const root = new URL('../fair-confirmation/luna-terminal-v1/', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');

test('the helper delta is solely the supported header grammar and its comment', () => {
  const source = readFileSync(new URL('terminal.mjs', root), 'utf8');
  assert.equal(sha(source), 'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70');
  const original = source.replace('      // Absolute end assertion also rejects a final line terminator (JS $ alone does not).\n', '')
    .replace(String.raw`/^text\/event-stream(?:[ \t]*;[ \t]*charset=utf-8)?(?![\s\S])/i`, String.raw`/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/i`);
  assert.equal(sha(original), '0aafcb1e222e1ad88ccb5132a52935dff3e171a798a37e1ff58012bdfab009fb');
});

test('the worker-owned successor vectors preserve all original reviewer assertions', () => {
  const copy = readFileSync(new URL('reviewer-vectors-revision.test.mjs', root), 'utf8');
  const restored = copy.split('\n').slice(3).join('\n')
    .replaceAll("'./terminal.mjs'", "'../fair-confirmation/luna-terminal-v1/terminal.mjs'")
    .replace('e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70', '0aafcb1e222e1ad88ccb5132a52935dff3e171a798a37e1ff58012bdfab009fb');
  assert.equal(sha(restored), '6fd1dfbffe537c04a727daf55f4181a8c69d77131eca365cca47280e4d22475b');
});
