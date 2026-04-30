/**
 * Pure transform applied to every wholesale-copied openclaude file in
 * the markdown wholesale-port. Imported by both
 * openclaude-markdown-port.mjs (writes) and
 * check-openclaude-markdown-wholesale-parity.mjs (verifies) so the two
 * cannot drift.
 */

function rewriteEnvVars(src) {
  return src
    .replace(/\bCLAUDE_CODE_([A-Z0-9_]+)/g, "AGENC_$1")
    .replace(/\bOPENCLAUDE_([A-Z0-9_]+)/g, "AGENC_$1");
}

function brandScrub(src) {
  let out = src;
  out = out.replace(/openclaude-clipboard/g, "agenc-clipboard");
  out = out.replace(/~\/\.claude\//g, "~/.agenc/");
  out = out.replace(/\bClaude Code\b/g, "AgenC");
  out = out.replace(/\bOpen Claude\b/g, "AgenC");
  out = out.replace(/\bOpenClaude\b/g, "AgenC");
  out = out.replace(/\bclaude\b(?!-)/g, "agenc");
  out = out.replace(
    /[ \t]*See [A-Z][a-zA-Z'’]+ [A-Z][a-zA-Z'’]+'s ["'][^"']+["'] in[\s\S]{0,80}?https:\/\/anthropic\.slack\.com\/[^\s.]+\.?/g,
    "",
  );
  out = out.replace(
    /[ \t]*\(https:\/\/anthropic\.slack\.com\/[^\s)]+\)\.?/g,
    "",
  );
  out = out.replace(/https:\/\/anthropic\.slack\.com\/[^\s.]+\.?/g, "");
  out = out.replace(/^[ \t]*\/\/[ \t]*\r?\n/gm, "");
  out = out.replace(/^([ \t]*\*[ \t]*\r?\n)\1+/gm, "$1");
  return out;
}

function annotateReactCompilerArgs(src) {
  return src.replace(
    /(function\s+[A-Z][a-zA-Z0-9_$]*\s*\()(t0)(\s*[,)])/g,
    (_m, prefix, arg, after) => `${prefix}${arg}: any${after}`,
  );
}

function relaxTsExpectError(src) {
  return src.replace(/@ts-expect-error/g, "@ts-ignore");
}

function rewriteTestFramework(src) {
  return src.replace(/(['"])bun:test\1/g, (_m, q) => `${q}vitest${q}`);
}

function normalizeExtensions(src) {
  return src.replace(
    /(['"])(\.\.?\/[^'"]+?)\.tsx?\1/g,
    (_m, q, tail) => (tail.endsWith(".d") ? _m : `${q}${tail}.js${q}`),
  );
}

function rewriteMarkdownPaths(src) {
  let out = src;
  out = out.replace(
    /(['"])\.\.\/ink\.js\1/g,
    (_m, q) => `${q}../ink-public.js${q}`,
  );
  out = out.replace(
    /(['"])\.\.\/components\/design-system\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}../design-system/${tail}${q}`,
  );
  out = out.replace(
    /import \{ feature \} from 'bun:bundle';?/g,
    "// bun:bundle.feature is Bun-build-time only; AgenC runs on Node and treats every feature flag as off.\nconst feature = (_: string): boolean => false;",
  );
  return out;
}

/**
 * AgenC↔openclaude API-shape adapters that can't be fixed by import
 * rewrites alone. Each one is per-file and idempotent.
 */
function applyApiAdapters(src, rel) {
  let out = src;

  if (
    rel === "components/Markdown.tsx" ||
    rel === "components/MarkdownTable.tsx"
  ) {
    // openclaude useTheme() returns [theme, setTheme]; AgenC useTheme()
    // returns the Theme object directly.
    out = out.replace(
      /const \[theme\] = useTheme\(\);/g,
      "const theme = useTheme();",
    );
  }

  if (rel === "utils/markdown.ts") {
    // openclaude's 'permission' theme color is their inline-code color;
    // AgenC's theme uses 'accent' for the equivalent emphasis role.
    out = out.replace(
      /case 'codespan': \{\n      \/\/ inline code\n      return color\('permission', theme\)\(token\.text\)\n    \}/,
      `case 'codespan': {
      // inline code — openclaude uses their 'permission' color; AgenC's
      // theme uses 'accent' for the equivalent emphasis role.
      return color('accent', theme)(token.text)
    }`,
    );
    // marked's 'text' token variant union includes Tokens.Tag /
    // Tokens.Generic which don't carry a `tokens` array. Cast to
    // Tokens.Text where it does.
    out = out.replace(
      /      if \(parent\?\.type === 'list_item'\) \{\n        return `\$\{orderedListNumber === null \? '-' : getListNumber\(listDepth, orderedListNumber\) \+ '\.'\} \$\{token\.tokens \? token\.tokens\.map\(_ => formatToken\(_, theme, listDepth, orderedListNumber, token, highlight\)\)\.join\(''\) : linkifyIssueReferences\(token\.text\)\}\$\{EOL\}`\n      \}/,
      `      if (parent?.type === 'list_item') {
        // marked's 'text' token variant union includes Tokens.Tag /
        // Tokens.Generic which don't carry a \`tokens\` array. Cast to
        // Tokens.Text where it does.
        const textToken = token as Tokens.Text
        return \`\${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} \${textToken.tokens ? textToken.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}\${EOL}\`
      }`,
    );
  }

  if (rel === "utils/hash.ts") {
    // AgenC's ambient.d.ts marks Bun.hash as optional (`hash?:`); the
    // typeof Bun !== 'undefined' guard alone doesn't satisfy the
    // optional-property narrowing. Add the explicit hash check.
    out = out.replace(
      /  if \(typeof Bun !== 'undefined'\) \{\n    return Bun\.hash\(content\)\.toString\(\)\n  \}/,
      `  if (typeof Bun !== 'undefined' && Bun.hash) {
    return Bun.hash(content).toString()
  }`,
    );
    out = out.replace(
      /  if \(typeof Bun !== 'undefined'\) \{\n    return Bun\.hash\(b, Bun\.hash\(a\)\)\.toString\(\)\n  \}/,
      `  if (typeof Bun !== 'undefined' && Bun.hash) {
    const hash = Bun.hash
    return hash(b, hash(a)).toString()
  }`,
    );
    // AgenC bundles as ESM via tsup; CommonJS \`require('crypto')\` fails
    // at runtime with "Dynamic require of 'crypto' is not supported".
    // Switch to a top-level node:crypto import + named createHash. Both
    // openclaude hashContent + hashPair share this fix.
    if (!/import \{ createHash \} from 'node:crypto'/.test(out)) {
      out = out.replace(
        /^(\/\*\*[\s\S]*?\*\/\n)?(export function djb2Hash)/m,
        `// AgenC bundles the runtime as ESM via tsup; \`require('crypto')\` is a
// CommonJS dynamic-require that ESM rejects with "Dynamic require of
// 'crypto' is not supported". Switch to a top-level node: import so
// the ESM build resolves it statically.
import { createHash } from 'node:crypto'

$1$2`,
      );
    }
    out = out.replace(
      /  \/\/ eslint-disable-next-line @typescript-eslint\/no-require-imports\n  const crypto = require\('crypto'\) as typeof import\('crypto'\)\n  return crypto\.createHash\('sha256'\)\.update\(content\)\.digest\('hex'\)/,
      `  return createHash('sha256').update(content).digest('hex')`,
    );
    out = out.replace(
      /  \/\/ eslint-disable-next-line @typescript-eslint\/no-require-imports\n  const crypto = require\('crypto'\) as typeof import\('crypto'\)\n  return crypto\n    \.createHash\('sha256'\)\n    \.update\(a\)\n    \.update\('\\0'\)\n    \.update\(b\)\n    \.digest\('hex'\)/,
      `  return createHash('sha256')
    .update(a)
    .update('\\0')
    .update(b)
    .digest('hex')`,
    );
  }

  return out;
}

export function transform(src, rel) {
  let out = src;
  out = rewriteMarkdownPaths(out);
  out = normalizeExtensions(out);
  out = rewriteTestFramework(out);
  out = rewriteEnvVars(out);
  out = annotateReactCompilerArgs(out);
  out = relaxTsExpectError(out);
  out = brandScrub(out);
  out = applyApiAdapters(out, rel);
  return out;
}
