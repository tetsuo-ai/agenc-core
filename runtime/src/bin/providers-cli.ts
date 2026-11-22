/**
 * Provider availability CLI for `agenc providers`.
 *
 * LP-24 keeps discovery in `runtime/src/llm/discovery/`; this file owns only
 * argument parsing, configuration loading, and terminal output.
 */

import { loadCanonicalConfig } from "../config/repository.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";
import {
  collectProviderAvailability,
  formatProviderAvailabilityReport,
  type CollectProviderAvailabilityOptions,
} from "../llm/discovery/provider-discovery.js";

export { collectProviderAvailability };

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
}

export function formatAgenCProvidersCliHelpText(): string {
  return [
    "Usage: agenc providers [--json] [--no-local-check]",
    "",
    "Shows provider readiness: credential status and local server health.",
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
        const ingress = captureSecureStorageIngress(
          options.env ?? process.env,
          options.agencHome,
        );
        const scopedOptions: AgenCProvidersCliOptions = Object.freeze({
          ...options,
          agencHome: ingress.home.path,
          env: ingress.environment,
        });
        const config = scopedOptions.config ?? (await loadCanonicalConfig({
          home: ingress.home,
          env: ingress.environment,
          onWarn: (message) => io.stderr.write(`${message}\n`),
        })).config;
        const report = await collectProviderAvailability({
          ...scopedOptions,
          config,
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
