import { rgPath } from "@vscode/ripgrep";

/**
 * Absolute, lockfile-pinned ripgrep binary shipped with the runtime.
 *
 * Editor read tools must never resolve `rg` through the operator's PATH:
 * read-only model input could otherwise select an arbitrary executable.
 */
export const PINNED_RIPGREP_PATH = rgPath;
