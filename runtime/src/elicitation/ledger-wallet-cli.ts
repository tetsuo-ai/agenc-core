/**
 * Model-facing discovery and explicitly approved installation for Ledger's
 * official wallet-cli.
 *
 * The status tool is read-only. The installer has a bypass-immune permission
 * prompt, so neither YOLO mode nor an eager model can silently download the
 * native wallet binary.
 */

import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { PermissionResult } from "../permissions/types.js";
import {
  getWalletCliStatus,
  installLatestWalletCli,
  WALLET_CLI_INSTALL_TOOL_NAME,
  WALLET_CLI_STATUS_TOOL_NAME,
} from "../services/Ledger/walletCli.js";

export const LEDGER_WALLET_CLI_ROUTING_GUIDANCE = [
  "Trusted Ledger hardware-wallet routing for this root-human turn:",
  "when Ledger means the hardware wallet or the official Wallet CLI, invoke the ledger-wallet-cli skill before running shell probes.",
  `Use ${WALLET_CLI_STATUS_TOOL_NAME} to detect the official CLI; never substitute the unrelated ledger, hledger, or solana binaries.`,
  `If it is missing, use ${WALLET_CLI_INSTALL_TOOL_NAME}; its mandatory approval prompt is the user's install confirmation, and no download may begin before approval.`,
  "The managed installer resolves @ledgerhq/wallet-cli@latest from the canonical npm registry on every approved install.",
  "If the user clearly means an accounting ledger instead, ignore this hardware-wallet routing.",
].join(" ");

const LEDGER_WORD = /(^|[^\p{L}\p{N}_])ledger(?=$|[^\p{L}\p{N}_])/iu;
const WALLET_CONTEXT =
  /\b(wallet(?:-cli)?|hardware|device|nano|flex|stax|usb|bitcoin|ethereum|solana|crypto|seed|sign(?:er|ing)?|transaction)\b/iu;
const ACCOUNTING_CONTEXT =
  /\b(accounting|bookkeeping|journal|double[- ]entry|general ledger|ledger entry|contabilidad|contable|libro mayor|asiento)\b/iu;

export function hasLedgerWalletCliMention(text: string): boolean {
  if (/\bwallet-cli\b/iu.test(text)) return true;
  if (!LEDGER_WORD.test(text)) return false;
  if (ACCOUNTING_CONTEXT.test(text) && !WALLET_CONTEXT.test(text)) return false;
  return true;
}

export interface CreateLedgerWalletCliToolsOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function errorResult(error: unknown): ToolResult {
  return {
    content: safeStringify({
      error: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}

export function createLedgerWalletCliStatusTool(
  options: CreateLedgerWalletCliToolsOptions,
): Tool {
  return {
    name: WALLET_CLI_STATUS_TOOL_NAME,
    description:
      "Check whether Ledger's official wallet-cli is available. Returns the exact trusted executable path for subsequent commands. Use this before any Ledger hardware-wallet shell probe.",
    metadata: {
      family: "ledger",
      source: "builtin",
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
      keywords: ["ledger", "wallet", "wallet-cli", "hardware", "status"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    isReadOnly: true,
    requiresApproval: false,
    recoveryCategory: "idempotent",
    async execute(): Promise<ToolResult> {
      try {
        const status = await getWalletCliStatus({
          ...(options.agencHome !== undefined
            ? { agencHome: options.agencHome }
            : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        });
        return {
          content: safeStringify({
            ...status,
            next: status.installed
              ? "Invoke the ledger-wallet-cli skill, then run the exact executable path returned above."
              : `Ask for install confirmation with ${WALLET_CLI_INSTALL_TOOL_NAME}. Do not use ledger, hledger, or solana as substitutes.`,
          }),
          codeModeResult: status,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createInstallLedgerWalletCliTool(
  options: CreateLedgerWalletCliToolsOptions,
): Tool {
  return {
    name: WALLET_CLI_INSTALL_TOOL_NAME,
    description:
      "Install or update Ledger's official wallet-cli in AgenC-managed storage. Every approved call resolves the current @ledgerhq/wallet-cli@latest release from registry.npmjs.org, verifies sha512 integrity, and installs only the matching platform binary. Never call silently: the user must approve the install prompt.",
    metadata: {
      family: "ledger",
      source: "builtin",
      hiddenByDefault: false,
      mutating: true,
      // The tool accepts no model-controlled paths and writes only beneath the
      // trusted AgenC home supplied by the runtime.
      virtualNoFsWrites: true,
      deferred: false,
      keywords: ["ledger", "wallet", "wallet-cli", "install", "latest"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: true,
    requiresUserInteraction: () => true,
    supportsParallelToolCalls: false,
    isConcurrencySafe: () => false,
    recoveryCategory: "side-effecting",
    interruptBehavior: () => "cancel",
    checkPermissions(): PermissionResult {
      return {
        behavior: "ask",
        message:
          "Install the latest official Ledger Wallet CLI in AgenC-managed storage? This downloads a platform-specific native package (roughly 150 MB unpacked) from registry.npmjs.org. Nothing has been downloaded yet.",
        decisionReason: {
          type: "safetyCheck",
          reason: "wallet_cli_install_requires_explicit_confirmation",
          classifierApprovable: false,
        },
      };
    },
    async execute(rawArgs): Promise<ToolResult> {
      const injected = rawArgs as ToolExecutionInjectedArgs;
      try {
        const result = await installLatestWalletCli({
          ...(options.agencHome !== undefined
            ? { agencHome: options.agencHome }
            : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
          ...(injected.__abortSignal !== undefined
            ? { signal: injected.__abortSignal }
            : {}),
          ...(injected.__onProgress !== undefined
            ? {
                onProgress: (message: string) =>
                  injected.__onProgress?.({
                    chunk: message,
                    stream: "status",
                  }),
              }
            : {}),
        });
        return {
          content: safeStringify({
            ...result,
            next:
              "Run ledger_wallet_cli_status again, invoke the ledger-wallet-cli skill, and use the returned executable path.",
          }),
          codeModeResult: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createLedgerWalletCliTools(
  options: CreateLedgerWalletCliToolsOptions,
): readonly Tool[] {
  return [
    createLedgerWalletCliStatusTool(options),
    createInstallLedgerWalletCliTool(options),
  ];
}
