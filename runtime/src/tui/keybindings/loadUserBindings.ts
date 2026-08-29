/**
 * Canonical keybinding projection and ConfigStore-backed hot reload.
 *
 * Keybindings are persisted only as `tui.keybindings` in layered
 * `config.toml`. This module never reads or watches a second operator file.
 */

import type { AgenCConfig, TuiKeybindingConfig } from "../../config/schema.js";
import { logForDebugging } from "../../utils/debug.js";
import { createSignal } from "../../utils/signal.js";
import { DEFAULT_BINDINGS } from "./defaultBindings.js";
import { parseBindings } from "./parser.js";
import type { KeybindingBlock, ParsedBinding } from "./types.js";
import { type KeybindingWarning, validateBindings } from "./validate.js";

export interface KeybindingConfigStore {
  readonly current?: () => AgenCConfig;
  readonly subscribe?: (
    listener: (config: AgenCConfig) => void,
  ) => (() => void) | void;
}

export type KeybindingsLoadResult = {
  readonly bindings: ParsedBinding[];
  readonly warnings: KeybindingWarning[];
};

let cachedSnapshot: AgenCConfig | null = null;
let cachedBindings: ParsedBinding[] | null = null;
let cachedWarnings: KeybindingWarning[] = [];
let subscribedStore: KeybindingConfigStore | null = null;
let unsubscribeStore: (() => void) | null = null;
const keybindingsChanged = createSignal<[result: KeybindingsLoadResult]>();

export function isKeybindingCustomizationEnabled(): boolean {
  return true;
}

function getDefaultParsedBindings(): ParsedBinding[] {
  return parseBindings(DEFAULT_BINDINGS);
}

function runtimeBlocks(
  blocks: readonly TuiKeybindingConfig[] | undefined,
): KeybindingBlock[] {
  if (blocks === undefined) return [];
  return blocks.map((block) => {
    const bindings: KeybindingBlock["bindings"] = {
      ...(block.bindings ?? {}),
    };
    for (const chord of block.unbind ?? []) bindings[chord] = null;
    return { context: block.context, bindings };
  });
}

function loadSnapshot(snapshot: AgenCConfig | undefined): KeybindingsLoadResult {
  if (snapshot !== undefined && cachedSnapshot === snapshot && cachedBindings) {
    return { bindings: cachedBindings, warnings: cachedWarnings };
  }

  const defaults = getDefaultParsedBindings();
  const userBlocks = runtimeBlocks(snapshot?.tui?.keybindings);
  const bindings = [...defaults, ...parseBindings(userBlocks)];
  const warnings = validateBindings(userBlocks, bindings);

  // ConfigStore ordinarily guarantees this cannot happen. Fail closed when a
  // partial embedding/test store bypasses strict validation: report the whole
  // rejected snapshot and retain defaults instead of silently dropping data.
  const hasErrors = warnings.some((warning) => warning.severity === "error");
  cachedSnapshot = snapshot ?? null;
  cachedBindings = hasErrors ? defaults : bindings;
  cachedWarnings = warnings;
  logForDebugging(
    `[keybindings] Projected ${userBlocks.length} canonical override blocks (${warnings.length} validation issue(s))`,
  );
  return { bindings: cachedBindings, warnings: cachedWarnings };
}

/** Load the active ConfigStore snapshot synchronously for render-time use. */
export function loadKeybindingsSyncWithWarnings(
  store?: KeybindingConfigStore,
): KeybindingsLoadResult {
  // Non-provider callers (for example shortcut labels rendered below
  // KeybindingSetup) consume the last canonical projection. They must not
  // replace it with defaults merely because ConfigStore is owned by the
  // provider rather than threaded through every presentation helper.
  if (store === undefined && cachedBindings !== null) {
    return { bindings: cachedBindings, warnings: cachedWarnings };
  }
  return loadSnapshot(store?.current?.());
}

export function loadKeybindingsSync(
  store?: KeybindingConfigStore,
): ParsedBinding[] {
  return loadKeybindingsSyncWithWarnings(store).bindings;
}

/**
 * Subscribe to the same ConfigStore that owns the initial snapshot. Its
 * canonical config watcher calls `reload()`, which delivers the new snapshot
 * here without another filesystem watcher.
 */
export function initializeKeybindingSubscription(
  store?: KeybindingConfigStore,
): void {
  if (store === undefined || typeof store.subscribe !== "function") return;
  if (subscribedStore === store && unsubscribeStore !== null) return;
  unsubscribeStore?.();
  subscribedStore = store;
  const unsubscribe = store.subscribe((snapshot) => {
    const result = loadSnapshot(snapshot);
    keybindingsChanged.emit(result);
  });
  unsubscribeStore = typeof unsubscribe === "function" ? unsubscribe : null;
}

export function disposeKeybindingSubscription(): void {
  unsubscribeStore?.();
  unsubscribeStore = null;
  subscribedStore = null;
  keybindingsChanged.clear();
}

export const subscribeToKeybindingChanges = keybindingsChanged.subscribe;

export function resetKeybindingLoaderForTesting(): void {
  disposeKeybindingSubscription();
  cachedSnapshot = null;
  cachedBindings = null;
  cachedWarnings = [];
}
