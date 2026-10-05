/**
 * Deferral of rarely used built-in tools (experimental, off by default).
 *
 * Every advertised tool schema rides on every request. In the Desktop test
 * rollouts these tools were called in under 2% of sessions, yet they cost
 * about 1.4k tokens per request. With `AGENC_DEFER_RARE_TOOLS` set in the
 * session's environment they load through system.searchTools like the other
 * deferred tools, and the system.searchTools description names them so the
 * model knows they exist.
 *
 * @module
 */

import { isEnvTruthy } from "../utils/envBoolean.js";

export const DEFER_RARE_TOOLS_ENV = "AGENC_DEFER_RARE_TOOLS";

/** Tool names, each with the few words the pointer uses to describe it. */
export const RARE_DEFERRED_TOOLS: ReadonlyArray<readonly [name: string, purpose: string]> = [
  ["ImagineImage", "generate or edit images"],
  ["ImagineVideo", "generate video"],
  ["XSearch", "search posts on X"],
  ["LSP", "language-server definitions and references"],
  ["NotebookRead", "read Jupyter notebooks"],
  ["request_ledger_transfer", "Ledger hardware wallet transfer"],
  ["ledger_wallet_cli_status", "Ledger wallet CLI status"],
  ["install_ledger_wallet_cli", "install the Ledger wallet CLI"],
  ["VerifyPlanExecution", "compare progress with an approved plan"],
  ["SendUserMessage", "send the user a progress note"],
];

const RARE_DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set(
  RARE_DEFERRED_TOOLS.map(([name]) => name),
);

/**
 * Whether the session environment turns deferral on. The bootstrap passes the
 * environment the session captured, so a client sets it per session; the
 * daemon's own process environment does not decide it.
 */
export function rareToolDeferralEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return isEnvTruthy(env[DEFER_RARE_TOOLS_ENV]);
}

export function isRareDeferredTool(name: string): boolean {
  return RARE_DEFERRED_TOOL_NAMES.has(name);
}

/**
 * One line naming the deferred rare tools present in this registry, appended
 * to the system.searchTools description. The list covers the whole session,
 * loaded or not, so the description does not change when one is loaded.
 */
export function rareToolPointer(presentNames: ReadonlySet<string>): string | undefined {
  const present = RARE_DEFERRED_TOOLS.filter(([name]) => presentNames.has(name));
  if (present.length === 0) return undefined;
  return `Deferred tools you can load with select: ${present
    .map(([name, purpose]) => `${name} (${purpose})`)
    .join(", ")}.`;
}
