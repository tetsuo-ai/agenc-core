/**
 * Pure transform applied to every openclaude src/ink/ file when porting
 * it into AgenC runtime/src/tui/ink/. Imported by the wholesale port helper
 * so transformation rules stay centralized.
 */
import path from "node:path";

export const KEEP_AGENC_VERSION = new Set([
  // AgenC's global.d.ts adds ink-link / ink-progress / ink-raw-ansi
  // intrinsics + the React 19 module declaration that openclaude's
  // slimmer version omits. Wholesale-port leaves it untouched.
  "global.d.ts",
]);

const VENDORED = new Set([
  "debug",
  "earlyInput",
  "env",
  "envUtils",
  "execFileNoThrow",
  "fullscreen",
  "intl",
  "log",
  "semver",
  "sliceAnsi",
  "state",
  "tempfile",
]);

function depthOf(rel) {
  return rel.split(path.sep).length - 1;
}
function vendoredPrefix(depth) {
  if (depth === 0) return "./vendored/";
  return "../".repeat(depth) + "vendored/";
}

function rewriteImports(src, rel) {
  const depth = depthOf(rel);
  const vp = vendoredPrefix(depth);

  let out = src;

  out = out.replace(
    /(['"])src\/native-ts\/yoga-layout\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}${vp}yoga-layout/${tail}${q}`,
  );

  out = out.replace(
    /(['"])src\/bootstrap\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}${vp}${tail}${q}`,
  );

  out = out.replace(
    /(['"])src\/utils\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}${vp}${tail}${q}`,
  );

  out = out.replace(
    /(['"])((?:\.\.\/)+)utils\/([^'"]+)\1/g,
    (_m, q, _dots, tail) => {
      const tailBase = tail.replace(/\.[tj]sx?$/, "");
      if (!VENDORED.has(tailBase)) return _m;
      return `${q}${vp}${tail}${q}`;
    },
  );

  out = out.replace(
    /(['"])((?:\.\.\/)+)bootstrap\/([^'"]+)\1/g,
    (_m, q, _dots, tail) => `${q}${vp}${tail}${q}`,
  );

  return out;
}

function normalizeExtensions(src) {
  return src.replace(
    /(['"])(\.\.?\/[^'"]+?)\.tsx?\1/g,
    (_m, q, tail) => {
      if (tail.endsWith(".d")) return _m;
      return `${q}${tail}.js${q}`;
    },
  );
}

function rewriteTestFramework(src) {
  return src.replace(/(['"])bun:test\1/g, (_m, q) => `${q}vitest${q}`);
}

function rewriteEnvVars(src) {
  let out = src;
  out = out.replace(/\bCLAUDE_CODE_([A-Z0-9_]+)/g, "AGENC_$1");
  out = out.replace(/\bOPENCLAUDE_([A-Z0-9_]+)/g, "AGENC_$1");
  return out;
}

function relaxTsExpectError(src) {
  return src.replace(/@ts-expect-error/g, "@ts-ignore");
}

function annotateReactCompilerArgs(src) {
  return src.replace(
    /(function\s+[A-Z][a-zA-Z0-9_$]*\s*\()(t0)(\s*[,)])/g,
    (_m, prefix, arg, after) => `${prefix}${arg}: any${after}`,
  );
}

function ensureLogForDebuggingImport(src, rel) {
  if (!/\blogForDebugging\b/.test(src)) return src;
  // Has any debug.js import?
  if (!/from\s+['"][^'"]*\/debug\.js['"]/.test(src)) {
    const depth = depthOf(rel);
    const vp = vendoredPrefix(depth);
    const importLine = `import { logForDebugging } from '${vp}debug.js';\n`;
    if (/from\s+['"][^'"]*\/log\.js['"]/.test(src)) {
      return src.replace(
        /(import [^;]*from ['"][^'"]*\/log\.js['"];\n)/,
        `${importLine}$1`,
      );
    }
    return importLine + src;
  }
  return src.replace(
    /import\s+\{\s*([^}]*?)\s*\}\s+from\s+(['"][^'"]*debug\.js['"]);/,
    (m, names, target) => {
      if (/\blogForDebugging\b/.test(names)) return m;
      return `import { ${names}, logForDebugging } from ${target};`;
    },
  );
}

function applyStrictnessFixes(src, rel) {
  // Targeted patches for specific openclaude→AgenC tsconfig strictness
  // mismatches. Each is idempotent (the fixed form doesn't re-match).
  let out = src;

  if (rel === path.join("components", "Button.tsx")) {
    out = out.replace(
      /const activeTimer = useRef\(null\);/g,
      "const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);",
    );
  }

  if (rel === "ink.tsx") {
    // Dead-code branch baked in by openclaude's react-compiler (NODE_ENV
    // substituted as the literal "production"). Cast silences TS2367.
    out = out.replace(
      /if \("production" === 'development'\)/g,
      `if (("production" as string) === 'development')`,
    );
    // Widen the stderr-intercept callback parameter to match Node's
    // `(err?: Error | null) => void` signature instead of openclaude's
    // older `(err?: Error)` shape.
    out = out.replace(
      /encodingOrCb\?: BufferEncoding \| \(\(err\?: Error\) => void\), cb\?: \(err\?: Error\) => void/g,
      "encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void",
    );
  }

  if (rel === "render-node-to-output.ts") {
    out = out.replace(
      /candidate\.nodeName !== '#text'/g,
      `(candidate.nodeName as string) !== '#text'`,
    );
  }

  return out;
}

function brandScrub(src) {
  let out = src;
  out = out.replace(/openclaude-clipboard/g, "agenc-clipboard");
  out = out.replace(/~\/\.claude\//g, "~/.agenc/");
  out = out.replace(/\bClaude Code\b/g, "AgenC");
  out = out.replace(/\bOpen Claude\b/g, "AgenC");
  out = out.replace(/\bOpenClaude\b/g, "AgenC");
  out = out.replace(/\bclaude\b(?!-)/g, "agenc");
  // Strip Anthropic-internal context entirely: dead Slack URLs and the
  // "See <Person>'s '<thing>'" insider citations that wrap them. These
  // are Claude-Code-employee artifacts — employee names + internal
  // jargon + private-workspace links no AgenC reader can reach.
  //
  // Order matters: handle the multiline "See ... in <slack-url>" form
  // FIRST (which removes the URL too), then any bare slack URL that
  // wasn't part of such a citation, then any orphan comment-shell
  // lines that held just a stripped URL.

  // 1. "See <First> <Last>'s '<thing>' in <slack-url>." — possibly
  //    spanning a JSDoc-continuation newline (`\n * ` or `\n // `).
  //    The leading space/punctuation is consumed so the prose flows.
  out = out.replace(
    /[ \t]*See [A-Z][a-zA-Z'’]+ [A-Z][a-zA-Z'’]+'s ["'][^"']+["'] in[\s\S]{0,80}?https:\/\/anthropic\.slack\.com\/[^\s.]+\.?/g,
    "",
  );

  // 2. Parenthesized citation in running prose: `... beat it (slack-url).`
  out = out.replace(
    /[ \t]*\(https:\/\/anthropic\.slack\.com\/[^\s)]+\)\.?/g,
    "",
  );

  // 3. Bare slack URL anywhere else (rare).
  out = out.replace(
    /https:\/\/anthropic\.slack\.com\/[^\s.]+\.?/g,
    "",
  );

  // 4. Orphan comment-shell lines (`// ` or ` * ` with no content) left
  //    behind when a stripped URL was alone on its line. Removing them
  //    keeps the surrounding JSDoc block clean.
  out = out.replace(/^[ \t]*\/\/[ \t]*\r?\n/gm, "");
  // For ` *` continuation lines: only remove if the line above OR below
  // is also a comment-block continuation, so we don't accidentally chew
  // a meaningful empty-paragraph separator. Simpler heuristic: remove
  // adjacent-duplicate ` *` lines (collapse `* \n * ` to a single ` *`).
  out = out.replace(/^([ \t]*\*[ \t]*\r?\n)\1+/gm, "$1");
  out = out.replace(/\brgb\(215,119,87\) \(AgenC\)/g, "rgb(215,119,87)");
  return out;
}

export function transform(src, rel) {
  let out = src;
  out = rewriteImports(out, rel);
  out = normalizeExtensions(out);
  out = rewriteTestFramework(out);
  out = rewriteEnvVars(out);
  out = annotateReactCompilerArgs(out);
  out = relaxTsExpectError(out);
  out = ensureLogForDebuggingImport(out, rel);
  out = applyStrictnessFixes(out, rel);
  out = brandScrub(out);
  return out;
}
