/**
 * Provider availability CLI for `agenc providers`.
 *
 * LP-24 keeps discovery in `runtime/src/llm/discovery/`; this file owns only
 * argument parsing, backend construction, and terminal output.
 */

import { createAuthBackend } from "../auth/selection.js";
import type { AuthBackend } from "../auth/backend.js";
import type { RemoteAuthBackendOptions } from "../auth/backends/remote.js";
import { loadConfig } from "../config/loader.js";
import { resolveAgencHome } from "../config/env.js";
import {
  collectProviderAvailability,
  formatProviderAvailabilityReport,
  type CollectProviderAvailabilityOptions,
  type ProviderAvailabilityEntry,
  type ProviderAvailabilityReport,
  type ProviderAvailabilityStatus,
  type ProviderKeyStatus,
  type ProviderLocalStatus,
} from "../llm/discovery/provider-discovery.js";

export {
  collectProviderAvailability,
  formatProviderAvailabilityReport,
  type CollectProviderAvailabilityOptions,
  type ProviderAvailabilityEntry,
  type ProviderAvailabilityReport,
  type ProviderAvailabilityStatus,
  type ProviderKeyStatus,
  type ProviderLocalStatus,
};

export type AgenCProvidersCliCommand =
  | {
      readonly kind: "providers";
      readonly json: boolean;
      readonly checkLocal: boolean;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCProvidersCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCProvidersCliOptions
  extends CollectProviderAvailabilityOptions {
  readonly agencHome?: string;
  readonly io?: AgenCProvidersCliIo;
  readonly remote?: RemoteAuthBackendOptions;
}

export function formatAgenCProvidersCliHelpText(): string {
  return [
    "Usage: agenc providers [--json] [--no-local-check]",
    "",
    "Shows provider readiness: BYOK key status, local server health, and AgenC subscription tier.",
    "",
    "Options:",
    "  --json             Print machine-readable JSON",
    "  --no-local-check   Skip localhost health probes",
    "",
    "Examples:",
    "  agenc providers",
    "  agenc providers --json",
    "  agenc providers --no-local-check",
  ].join("\n");
}

export function parseAgenCProvidersCliArgs(
  argv: readonly string[],
): AgenCProvidersCliCommand | null {
  if (argv[0] !== "providers") return null;
  let json = false;
  let checkLocal = true;
  for (const arg of argv.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCProvidersCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-local-check") {
      checkLocal = false;
      continue;
    }
    return {
      kind: "error",
      message: `providers command does not accept argument '${arg}'`,
    };
  }
  return { kind: "providers", json, checkLocal };
}

export async function runAgenCProvidersCli(
  command: AgenCProvidersCliCommand,
  options: AgenCProvidersCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCProvidersCliHelpText()}\n`);
      return 1;
    case "providers":
      try {
        const authBackend =
          options.authBackend ??
          await resolveAgenCProvidersCliBackend(options, io);
        const report = await collectProviderAvailability({
          ...options,
          authBackend,
          checkLocal: command.checkLocal,
        });
        if (command.json) {
          io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          io.stdout.write(`${formatProviderAvailabilityReport(report)}\n`);
        }
        return 0;
      } catch (error) {
        io.stderr.write(
          `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
  }
}

export async function resolveAgenCProvidersCliBackend(
  options: AgenCProvidersCliOptions,
  io: AgenCProvidersCliIo,
): Promise<AuthBackend | undefined> {
  if (options.authBackend !== undefined) return options.authBackend;
  const env = options.env ?? process.env;
  const agencHome = options.agencHome ?? resolveAgencHome(env);
  const loadedConfig = await loadConfig({
    home: agencHome,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  return createAuthBackend(loadedConfig.config, {
    agencHome,
    env,
    ...(options.remote !== undefined ? { remote: options.remote } : {}),
  });
}
