/**
 * Default keybindings for the AgenC TUI.
 *
 * Ported from the reference Ink runtime at openclaude/src/keybindings.
 * AgenC only exposes the contexts that are live in this shell today, but
 * those contexts should match upstream behavior instead of carrying local
 * narrowed-scope shortcuts.
 *
 * Public contract:
 *   - `DEFAULT_BINDINGS` is a `Record<BindingContext, BindingMap>`.
 *   - `normalizeKeySequence()` is the canonical form used by the resolver
 *     for both built-in and user bindings: lowercased, modifiers sorted
 *     alphabetically (alt/ctrl/meta/shift), split into chord tokens on
 *     whitespace then re-joined with a single space.
 *   - `MODE_CYCLE_KEY` is the platform-adjusted trigger for
 *     `chat:cycleMode` ('shift+tab' by default; 'meta+m' fallback for
 *     plain Win32 terminals without VT mode support).
 */

export type BindingContext = "global" | "chat" | "modal" | "transcript";

export type BindingCommand =
  | "app:interrupt"
  | "app:exit"
  | "app:redraw"
  | "app:toggleTranscript"
  | "scroll:pageUp"
  | "scroll:pageDown"
  | "scroll:halfPageUp"
  | "scroll:halfPageDown"
  | "scroll:fullPageUp"
  | "scroll:fullPageDown"
  | "scroll:lineUp"
  | "scroll:lineDown"
  | "scroll:top"
  | "scroll:bottom"
  | "history:search"
  | "history:prev"
  | "history:next"
  | "chat:cycleMode"
  | "chat:submit"
  | "chat:acceptSuggestion"
  | "chat:newline"
  | "chat:cancel"
  | "chat:externalEditor"
  | "chat:imagePaste"
  | "modal:confirm"
  | "modal:cancel"
  | "modal:yes"
  | "modal:no"
  | "modal:allowSession"
  | "modal:deny"
  | "transcript:toggleShowAll"
  | "transcript:exit";

export interface BindingMap {
  [keySequence: string]: BindingCommand;
}

const MODIFIER_ORDER: Record<string, number> = {
  alt: 0,
  ctrl: 1,
  meta: 2,
  shift: 3,
};

const MODIFIER_SET = new Set(Object.keys(MODIFIER_ORDER));

/**
 * Normalize a single chord token such as `Shift+Ctrl+A` into a canonical
 * `ctrl+shift+a` form. Modifiers are lowercased and sorted alphabetically
 * with a stable order; the trailing key name is lowercased. Unknown parts
 * that look like keys are kept as-is (lowercased) at the end.
 */
function normalizeChord(raw: string): string {
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  if (parts.length === 0) return "";

  const modifiers: string[] = [];
  const remainder: string[] = [];

  for (const part of parts) {
    if (MODIFIER_SET.has(part)) {
      modifiers.push(part);
    } else {
      remainder.push(part);
    }
  }

  // Dedupe modifiers, then sort alphabetically. Using ASCII-order here (which
  // matches the MODIFIER_ORDER map) keeps the canonical form deterministic and
  // easy to reason about in user bindings.
  const uniqueModifiers = Array.from(new Set(modifiers)).sort(
    (a, b) =>
      (MODIFIER_ORDER[a] ?? Number.MAX_SAFE_INTEGER) -
      (MODIFIER_ORDER[b] ?? Number.MAX_SAFE_INTEGER),
  );

  return [...uniqueModifiers, ...remainder].join("+");
}

/**
 * Normalize a full key sequence, which may be a single chord (`ctrl+a`) or a
 * multi-chord sequence separated by whitespace (`ctrl+x ctrl+e`). Each chord
 * is normalized independently; whitespace is collapsed to a single space.
 */
export function normalizeKeySequence(key: string): string {
  if (typeof key !== "string") return "";
  const chords = key
    .trim()
    .split(/\s+/)
    .filter((c) => c.length > 0)
    .map(normalizeChord);
  return chords.join(" ");
}

/**
 * Best-effort check for a "recent enough" Windows Terminal / Node build that
 * honors VT mode for bare-modifier keys such as Shift+Tab. The upstream probe
 * checks Node and Bun version gates; here we keep it simple and only trust a
 * few marker environment variables.
 *
 * Keeping this function exported separately so unit tests can stub
 * `process.platform` / `process.env` and exercise both branches.
 */
export function isRecentModernWindowsTerminal(): boolean {
  // `WT_SESSION` is Windows Terminal's own marker; `WT_PROFILE_ID` likewise.
  // If either is set we treat the terminal as VT-mode capable. VSCode and
  // ConEmu also set telltales we accept.
  const env = process.env;
  if (typeof env.WT_SESSION === "string" && env.WT_SESSION.length > 0)
    return true;
  if (typeof env.WT_PROFILE_ID === "string" && env.WT_PROFILE_ID.length > 0)
    return true;
  if (env.TERM_PROGRAM === "vscode") return true;
  if (env.ConEmuANSI === "ON") return true;
  return false;
}

/**
 * Returns true if the current terminal is expected to deliver Shift+Tab as a
 * distinct keypress. Non-Windows platforms always return true; Win32 returns
 * true only when a modern terminal is detected.
 */
export function detectShiftTabCapable(): boolean {
  if (process.platform !== "win32") return true;
  return isRecentModernWindowsTerminal();
}

// Computed once at module load. Tests that need to exercise the alternate
// branch stub `process.platform` / `process.env` and then call
// `detectShiftTabCapable()` directly; the branch for `MODE_CYCLE_KEY` is
// validated via the exported helper because overriding `process.platform`
// after this constant is frozen wouldn't rewrite it.
export const MODE_CYCLE_KEY: "shift+tab" | "meta+m" = detectShiftTabCapable()
  ? "shift+tab"
  : "meta+m";

/**
 * The canonical default keybinding set. Stored as a plain `Record` so user
 * overrides from `~/.agenc/keybindings.json` can merge in key-by-key without
 * having to preserve insertion order.
 *
 * Notes on the shape:
 *   - `ctrl+c` and `ctrl+d` live in the `global` map so the provider can
 *     see them from every context. `ctrl+c` interrupts active work
 *     immediately; `ctrl+d` keeps the double-press exit guard implemented
 *     in `KeybindingContext.tsx`. They MUST NOT be rebound.
 *   - `enter` appears in both `chat` and `modal` so whichever context is
 *     active wins; `modal` takes priority when pushed on top.
 *   - `shift+enter` maps to `chat:newline`; the underlying key event must
 *     be delivered as a distinct chord (Kitty keyboard protocol or xterm
 *     modifyOtherKeys). Terminals that can't deliver it will simply never
 *     fire this binding.
 *   - `ctrl+x ctrl+e` is a two-chord sequence; the provider buffers the
 *     first chord for up to 1000 ms and resets on any unrelated key.
 */
export const DEFAULT_BINDINGS: Record<BindingContext, BindingMap> = {
  global: {
    [normalizeKeySequence("ctrl+c")]: "app:interrupt",
    [normalizeKeySequence("ctrl+d")]: "app:exit",
    [normalizeKeySequence("ctrl+l")]: "app:redraw",
    [normalizeKeySequence("ctrl+o")]: "app:toggleTranscript",
    [normalizeKeySequence("ctrl+r")]: "history:search",
    [normalizeKeySequence("pageup")]: "scroll:pageUp",
    [normalizeKeySequence("pagedown")]: "scroll:pageDown",
    [normalizeKeySequence("wheelup")]: "scroll:lineUp",
    [normalizeKeySequence("wheeldown")]: "scroll:lineDown",
    [normalizeKeySequence("ctrl+home")]: "scroll:top",
    [normalizeKeySequence("ctrl+end")]: "scroll:bottom",
  },
  chat: {
    [normalizeKeySequence(MODE_CYCLE_KEY)]: "chat:cycleMode",
    [normalizeKeySequence("enter")]: "chat:submit",
    [normalizeKeySequence("tab")]: "chat:acceptSuggestion",
    [normalizeKeySequence("shift+enter")]: "chat:newline",
    [normalizeKeySequence("ctrl+j")]: "chat:newline",
    [normalizeKeySequence("escape")]: "chat:cancel",
    [normalizeKeySequence("up")]: "history:prev",
    [normalizeKeySequence("down")]: "history:next",
    [normalizeKeySequence("ctrl+x ctrl+e")]: "chat:externalEditor",
    [normalizeKeySequence("ctrl+v")]: "chat:imagePaste",
    [normalizeKeySequence("alt+v")]: "chat:imagePaste",
  },
  modal: {
    [normalizeKeySequence("enter")]: "modal:confirm",
    [normalizeKeySequence("escape")]: "modal:cancel",
    [normalizeKeySequence("y")]: "modal:yes",
    [normalizeKeySequence("n")]: "modal:no",
    [normalizeKeySequence("a")]: "modal:allowSession",
    [normalizeKeySequence("d")]: "modal:deny",
  },
  transcript: {
    [normalizeKeySequence("ctrl+e")]: "transcript:toggleShowAll",
    [normalizeKeySequence("ctrl+c")]: "transcript:exit",
    [normalizeKeySequence("escape")]: "transcript:exit",
    [normalizeKeySequence("q")]: "transcript:exit",
    [normalizeKeySequence("up")]: "scroll:lineUp",
    [normalizeKeySequence("down")]: "scroll:lineDown",
    [normalizeKeySequence("k")]: "scroll:lineUp",
    [normalizeKeySequence("j")]: "scroll:lineDown",
    [normalizeKeySequence("ctrl+p")]: "scroll:lineUp",
    [normalizeKeySequence("ctrl+n")]: "scroll:lineDown",
    [normalizeKeySequence("pageup")]: "scroll:pageUp",
    [normalizeKeySequence("pagedown")]: "scroll:pageDown",
    [normalizeKeySequence("ctrl+u")]: "scroll:halfPageUp",
    [normalizeKeySequence("ctrl+d")]: "scroll:halfPageDown",
    [normalizeKeySequence("ctrl+b")]: "scroll:fullPageUp",
    [normalizeKeySequence("ctrl+f")]: "scroll:fullPageDown",
    [normalizeKeySequence("b")]: "scroll:fullPageUp",
    [normalizeKeySequence("space")]: "scroll:fullPageDown",
    [normalizeKeySequence("home")]: "scroll:top",
    [normalizeKeySequence("end")]: "scroll:bottom",
    [normalizeKeySequence("g")]: "scroll:top",
    [normalizeKeySequence("shift+g")]: "scroll:bottom",
  },
};

/**
 * Compile-time exhaustive list of all binding commands. Kept as a constant
 * so the test suite can assert that every literal in `BindingCommand`
 * appears in at least one of the three binding maps.
 */
export const ALL_BINDING_COMMANDS: readonly BindingCommand[] = [
  "app:interrupt",
  "app:exit",
  "app:redraw",
  "app:toggleTranscript",
  "scroll:pageUp",
  "scroll:pageDown",
  "scroll:halfPageUp",
  "scroll:halfPageDown",
  "scroll:fullPageUp",
  "scroll:fullPageDown",
  "scroll:lineUp",
  "scroll:lineDown",
  "scroll:top",
  "scroll:bottom",
  "history:search",
  "history:prev",
  "history:next",
  "chat:cycleMode",
  "chat:submit",
  "chat:acceptSuggestion",
  "chat:newline",
  "chat:cancel",
  "chat:externalEditor",
  "chat:imagePaste",
  "modal:confirm",
  "modal:cancel",
  "modal:yes",
  "modal:no",
  "modal:allowSession",
  "modal:deny",
  "transcript:toggleShowAll",
  "transcript:exit",
];

/**
 * Runtime-safe set of known binding contexts. Used by `loadUserBindings` to
 * reject unknown keys from the JSON file.
 */
export const KNOWN_BINDING_CONTEXTS: readonly BindingContext[] = [
  "global",
  "chat",
  "modal",
  "transcript",
];

/**
 * Runtime-safe set of known commands, used by `loadUserBindings` to reject
 * malformed entries without having to roundtrip through the TypeScript type
 * system at runtime.
 */
export const KNOWN_BINDING_COMMANDS: ReadonlySet<BindingCommand> = new Set(
  ALL_BINDING_COMMANDS,
);
