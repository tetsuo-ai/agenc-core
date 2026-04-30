/**
 * Pure transform applied to openclaude DiagnosticsDisplay + transitive
 * UI deps during the diagnostics wholesale-port.
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
  out = out.replace(
    /(['"])\.\/design-system\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}../design-system/${tail}${q}`,
  );
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

function rewriteDiagnosticsPaths(src) {
  let out = src;
  // openclaude imports DiagnosticTrackingService from
  // ../services/diagnosticTracking; AgenC ships a cherry-pick at the
  // same relative path. The path itself doesn't need rewriting — the
  // cherry-pick file lives at runtime/src/tui/services/diagnosticTracking.ts.
  // openclaude imports getCwd from ../utils/cwd; AgenC ships a
  // cherry-pick. Same — no rewrite needed.
  // openclaude imports Attachment from ../utils/attachments; AgenC
  // cherry-picks just the diagnostics variant. Same path, no rewrite.
  return out;
}

export function transform(src, _rel) {
  let out = src;
  out = rewriteCommon(out);
  out = rewriteDiagnosticsPaths(out);
  out = normalizeExtensions(out);
  out = rewriteEnvVars(out);
  out = annotateReactCompilerArgs(out);
  out = relaxTsExpectError(out);
  out = brandScrub(out);
  return out;
}
