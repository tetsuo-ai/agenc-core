/**
 * Pure transform applied to openclaude src/hooks/useCopyOnSelect.ts +
 * src/components/ScrollKeybindingHandler.tsx during the selection
 * wholesale-port. Imported by both the port script and the parity gate.
 */

function rewriteCommon(src) {
  let out = src;
  // Common shared rules with the markdown family.
  out = out.replace(
    /(['"])\.\.\/ink\.js\1/g,
    (_m, q) => `${q}../ink-public.js${q}`,
  );
  out = out.replace(
    /(['"])\.\.\/components\/design-system\/([^'"]+)\1/g,
    (_m, q, tail) => `${q}../design-system/${tail}${q}`,
  );
  return out;
}

function rewriteSelectionPaths(src) {
  let out = src;
  // openclaude getTheme lives at src/utils/theme.ts; AgenC's getTheme
  // lives at runtime/src/tui/theme.ts.
  out = out.replace(
    /(['"])\.\.\/utils\/theme\.js\1/g,
    (_m, q) => `${q}../theme.js${q}`,
  );
  // openclaude getGlobalConfig from src/utils/config.ts → AgenC config-shim.
  out = out.replace(
    /(['"])\.\.\/utils\/config\.js\1/g,
    (_m, q) => `${q}../utils/config-shim.js${q}`,
  );
  // openclaude useNotifications context lives at src/context/notifications.tsx;
  // AgenC's lives at runtime/src/tui/state/NotificationsContext.tsx.
  out = out.replace(
    /(['"])\.\.\/context\/notifications\.js\1/g,
    (_m, q) => `${q}../state/NotificationsContext.js${q}`,
  );
  // AgenC's keybindings hook is `useKeybindings.ts` (plural).
  out = out.replace(
    /(['"])\.\.\/keybindings\/useKeybinding\.js\1/g,
    (_m, q) => `${q}../keybindings/useKeybindings.js${q}`,
  );
  return out;
}

function normalizeExtensions(src) {
  return src.replace(
    /(['"])(\.\.?\/[^'"]+?)\.tsx?\1/g,
    (_m, q, tail) => (tail.endsWith(".d") ? _m : `${q}${tail}.js${q}`),
  );
}

function rewriteTestFramework(src) {
  return src.replace(/(['"])bun:test\1/g, (_m, q) => `${q}vitest${q}`);
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

function applyApiAdapters(src, rel) {
  let out = src;

  if (rel === "hooks/useCopyOnSelect.ts") {
    // openclaude useTheme() returns [themeName, …] and getTheme(themeName)
    // takes the name. AgenC's useTheme() returns the resolved Theme and
    // getTheme() takes no args. Adapt both call sites.
    out = out.replace(
      /export function useSelectionBgColor\(selection: Selection\): void \{\n  const \[themeName\] = useTheme\(\)\n  useEffect\(\(\) => \{\n    selection\.setSelectionBgColor\(getTheme\(themeName\)\.selectionBg\)\n  \}, \[selection, themeName\]\)\n\}/,
      `export function useSelectionBgColor(selection: Selection): void {
  // openclaude shape: const [themeName] = useTheme(); getTheme(themeName).selectionBg
  // AgenC shape:      useTheme() returns the resolved Theme; getTheme()
  //                   takes no args and returns the same shape.
  const theme = useTheme()
  useEffect(() => {
    selection.setSelectionBgColor(getTheme().colors.selectionBg)
  }, [selection, theme])
}`,
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

export function transform(src, rel) {
  let out = src;
  out = rewriteCommon(out);
  out = rewriteSelectionPaths(out);
  out = normalizeExtensions(out);
  out = rewriteTestFramework(out);
  out = rewriteEnvVars(out);
  out = annotateReactCompilerArgs(out);
  out = relaxTsExpectError(out);
  out = applyApiAdapters(out, rel);
  out = brandScrub(out);
  return out;
}
