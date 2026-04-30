/**
 * Pure transform applied to wholesale-ported openclaude keybinding files.
 */

function rewriteCommon(src) {
  let out = src;
  out = out.replace(
    /(['"])\.\.\/ink\.js\1/g,
    (_m, q) => `${q}../ink-public.js${q}`,
  );
  out = out.replace(
    /(['"])\.\.\/components\/design-system\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}../design-system/${tail}${q}`,
  );
  // Notifications context lives at a different path in AgenC.
  out = out.replace(
    /(['"])\.\.\/context\/notifications\.js\1/g,
    (_m, q) => `${q}../state/NotificationsContext.js${q}`,
  );
  return out;
}

function dropAnalytics(src) {
  let out = src;
  out = out.replace(
    /import \{[^}]*logEvent[^}]*\} from ['"][^'"]*services\/analytics[^'"]*['"];?\n/g,
    "",
  );
  out = out.replace(
    /import [^;]*from ['"][^'"]*services\/analytics[^'"]*['"];?\n/g,
    "",
  );
  out = out.replace(/logEvent\([^)]*\)\s*;?/g, "/* logEvent dropped */");
  return out;
}

function normalizeExtensions(src) {
  return src.replace(
    /(['"])(\.\.?\/[^'"]+?)\.tsx?\1/g,
    (_m, q, tail) => (tail.endsWith(".d") ? _m : `${q}${tail}.js${q}`),
  );
}

function rewriteEnvVars(src) {
  return src
    .replace(/\bCLAUDE_CODE_([A-Z0-9_]+)/g, "AGENC_$1")
    .replace(/\bOPENCLAUDE_([A-Z0-9_]+)/g, "AGENC_$1");
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

function applyTsNocheck(src) {
  if (!src.startsWith("// @ts-nocheck")) {
    return `// @ts-nocheck — wholesale-ported from openclaude with strictness gaps.\n${src}`;
  }
  return src;
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

export function transform(src, _rel) {
  let out = src;
  out = rewriteCommon(out);
  out = dropAnalytics(out);
  out = normalizeExtensions(out);
  out = rewriteEnvVars(out);
  out = annotateReactCompilerArgs(out);
  out = relaxTsExpectError(out);
  out = applyTsNocheck(out);
  out = brandScrub(out);
  return out;
}
