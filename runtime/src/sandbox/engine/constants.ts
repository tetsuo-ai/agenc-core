/**
 * Pure constants shared by the sandbox engine and the platform launchers.
 *
 * This module imports nothing. Keep it that way: `linux-launcher/config.ts`
 * reads engine values while its own module initialises, and the engine
 * index re-exports the manager, which reaches the launcher config through
 * `bound-readonly-profile.ts`. Sourcing the shared constants from a leaf
 * breaks that cycle, so a fresh process can import `engine/index.js` first
 * without hitting a temporal-dead-zone `ReferenceError` (the m5 crash-child
 * fixture did exactly that after #2455).
 */

export const AGENC_LINUX_SANDBOX_ARG0 = "agenc-linux-sandbox";
export const PROTECTED_METADATA_PATH_NAMES = [".git", ".agenc", ".agents"] as const;
/** Path inside the Linux sandbox where the inherited cwd is bind-mounted. */
export const AGENC_INHERITED_CWD_SANDBOX_PATH = "/dev/.agenc-inherited-cwd";
