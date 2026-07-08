/**
 * AgenC protocol transport barrel + factory.
 *
 * `createProtocolTransport` maps the `[protocol]` config block to a
 * transport instance. The default is the `NullTransport` (config absent,
 * `enabled` false/absent, or adapter `"null"`), which preserves today's
 * honest "not attached" stub behavior. Only an explicit
 * `enabled = true` + `adapter = "marketplace-cli"` opts into the
 * read-only marketplace CLI adapter.
 *
 * @module
 */

import type { ProtocolConfig } from "../config/schema.js";
import { MarketplaceKitCliAdapter } from "./marketplace-cli.js";
import { NullTransport } from "./null-transport.js";
import type { ProtocolTransport } from "./types.js";

export type {
  ClaimableTaskList,
  ClaimableTaskSummary,
  ListClaimableOptions,
  ProtocolErrorCode,
  ProtocolResult,
  ProtocolTransport,
  ProtocolTransportError,
  TaskDetail,
  TaskModerationSummary,
} from "./types.js";
export {
  isValidTaskPda,
  protocolError,
  sanitizeUntrustedText,
} from "./types.js";
export { NullTransport } from "./null-transport.js";
export {
  MarketplaceKitCliAdapter,
  type MarketplaceKitCliAdapterOptions,
} from "./marketplace-cli.js";

export interface CreateProtocolTransportOptions {
  /** Base dir for the `node_modules/.bin` fallback (default `process.cwd()`). */
  readonly cwd?: string;
  /** Env snapshot consulted for `AGENC_MARKETPLACE_CLI` (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createProtocolTransport(
  config: ProtocolConfig | undefined,
  opts: CreateProtocolTransportOptions = {},
): ProtocolTransport {
  if (config?.enabled === true && config.adapter === "marketplace-cli") {
    return new MarketplaceKitCliAdapter({
      cliPath: config.cli_path,
      cwd: opts.cwd,
      env: opts.env,
    });
  }
  return new NullTransport();
}
