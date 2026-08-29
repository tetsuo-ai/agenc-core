/**
 * AgenC protocol transport barrel + factory.
 *
 * `createProtocolTransport` maps the `[protocol]` config block to a
 * transport instance. Disabled or absent protocol configuration is handled
 * by the command layer without constructing a transport. The only transport
 * this factory can construct is the validated, read-only marketplace CLI
 * adapter.
 *
 * @module
 */

import type { MarketplaceCliProtocolConfig } from "../config/schema.js";
import { MarketplaceKitCliAdapter } from "./marketplace-cli.js";
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
  config: MarketplaceCliProtocolConfig,
  opts: CreateProtocolTransportOptions = {},
): ProtocolTransport {
  return new MarketplaceKitCliAdapter({
    cliPath: config.cli_path,
    cwd: opts.cwd,
    env: opts.env,
  });
}
