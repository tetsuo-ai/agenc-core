// Strict bounded JSONL ingestion retaining every numeric lexeme. No I/O.
const lexemes = new WeakMap();
const fail = () => { throw new Error('Luna accounting evidence refused'); };
export const numericLexeme = value => value !== null && typeof value === 'object' ? lexemes.get(value) : undefined;
export function decimalParts(text) {
  if (typeof text !== 'string' || text.length > 128) fail();
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || Math.abs(Number(match[3] ?? 0)) > 400) fail();
  return { coefficient: BigInt(match[1] + (match[2] ?? '')),
    exponent: Number(match[3] ?? 0) - (match[2]?.length ?? 0) };
}
export function parseLedgerBytes(raw) {
  if (!(raw instanceof Uint8Array) || raw.length > 16 * 1024 * 1024) fail();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { fail(); }
  if (text.startsWith('\ufeff') || (text.length && !text.endsWith('\n'))) fail();
  const lines = text.length ? text.slice(0, -1).split('\n') : [];
  if (lines.length > 100_000) fail();
  let nodes = 0;
  const rows = lines.map(line => {
    let at = 0;
    const space = () => { while (/[\x20\t\r]/.test(line[at] ?? '\0')) at++; };
    const string = () => {
      const start = at++;
      if (line[start] !== '"') fail();
      while (at < line.length) {
        if (line[at] === '\\') { at += 2; continue; }
        if (line[at++] === '"') {
          let value;
          try { value = JSON.parse(line.slice(start, at)); } catch { fail(); }
          if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
          return value;
        }
      }
      fail();
    };
    const value = (depth = 0) => {
      if (++nodes > 500_000 || depth > 32) fail();
      space();
      if (line[at] === '"') return string();
      if (line[at] === '{') {
        at++; space(); const out = Object.create(null), seen = new Set();
        if (line[at] === '}') { at++; return Object.freeze(out); }
        for (;;) {
          space(); const key = string(); if (seen.has(key)) fail(); seen.add(key);
          space(); if (line[at++] !== ':') fail(); out[key] = value(depth + 1); space();
          const token = line[at++]; if (token === '}') return Object.freeze(out);
          if (token !== ',') fail();
        }
      }
      if (line[at] === '[') {
        at++; space(); const out = [];
        if (line[at] === ']') { at++; return Object.freeze(out); }
        for (;;) {
          out.push(value(depth + 1)); space(); const token = line[at++];
          if (token === ']') return Object.freeze(out); if (token !== ',') fail();
        }
      }
      for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
        if (line.startsWith(token, at)) { at += token.length; return result; }
      }
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(line.slice(at));
      if (!match || match[0].length > 128) fail();
      // Signed numeric tokens are retained, then rejected in monetary/count
      // positions by their exact nonnegative decimal contracts.
      decimalParts(match[0].replace(/^-/, ''));
      at += match[0].length;
      const box = Object.freeze(Object.create(null)); lexemes.set(box, match[0]); return box;
    };
    const row = value(); space();
    if (at !== line.length || row === null || typeof row !== 'object' || Array.isArray(row) || numericLexeme(row) !== undefined) fail();
    return row;
  });
  return Object.freeze(rows);
}
