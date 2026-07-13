import { logPayload, toolNameDisplay, type ToolInvocation } from "../tools/context.js";
import type { Tool } from "../tools/types.js";
import { nonEmptyString as asString } from "../utils/stringUtils.js";
import type { TransactionGuardInput } from "./types.js";

const SOLANA_SIGNAL_RE =
  /\b(solana|spl-token|anchor|metaplex|jupiter|orca|raydium|@solana\/web3\.js|sendTransaction|sendRawTransaction|sendAndConfirmTransaction|signTransaction|signAllTransactions|requestAirdrop)\b/iu;
const DIRECT_TRANSACTION_TOOL_RE =
  /\b(sendRawTransaction|sendTransaction|sendAndConfirmTransaction|submitTransaction|signTransaction|signAllTransactions|wallet\.sign|walletSign|requestAirdrop)\b/iu;
const SOLANA_WRITE_SIGNAL_RE =
  /\b(transfer|airdrop|requestAirdrop|deploy|upgrade|send-tx|submit|submitTransaction|execute|confirm|sign|walletSign|sendRawTransaction|sendTransaction|sendAndConfirmTransaction|signTransaction|signAllTransactions|swap|mint|burn|approve|authorize|revoke|close|set-authority|set-buffer-authority|write-buffer|create-account|create-token|create-associated-token-account)\b/iu;
const SOLANA_PROGRAM_WRITE_RE =
  /\bsolana\s+program\s+(deploy|write-buffer|set-buffer-authority|close|upgrade)\b/iu;
// DevNet must be asserted from a URL/flag-shaped position, not a bare "devnet"
// word anywhere in the (attacker-influenced) command/args/payload — otherwise a
// comment like "# devnet test" on a mainnet transfer made the framework vouch
// "targeting DevNet." and set devnetRpcExplicit, biasing the benign-leaning judge.
const DEVNET_RPC_RE =
  /(?:api\.devnet\.solana\.com|(?:--url|--rpc-url|-u|--network|--cluster)(?:=|\s+)\S*(?:devnet|testnet)|\b(?:network|cluster)\s*[:=]\s*["']?(?:devnet|testnet))/iu;
const MAINNET_RPC_RE =
  /(?:api\.mainnet-beta\.solana\.com|\bmainnet-beta\b|(?:--url|--rpc-url|-u|--network|--cluster)(?:=|\s+)\S*mainnet|\b(?:network|cluster)\s*[:=]\s*["']?mainnet)/iu;
const SENSITIVE_KEY_RE =
  /(api[_-]?key|auth|authorization|bearer|keypairContents|mnemonic|password|private[_-]?key|secret|seed|token)/iu;

function stringifyForScan(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
  } catch {
    return String(value);
  }
}

function compactString(value: string, limit = 4096): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

function sanitizeForDocket(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[max-depth]";
  if (typeof value === "string") return compactString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForDocket(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
    return Object.fromEntries(
      entries.map(([key, nested]) => [
        key,
        SENSITIVE_KEY_RE.test(key)
          ? "[redacted]"
          : sanitizeForDocket(nested, depth + 1),
      ]),
    );
  }
  return String(value);
}

function extractCommand(args: Record<string, unknown>): string | undefined {
  return (
    asString(args.command) ??
    asString(args.cmd) ??
    asString(args.chars) ??
    asString(args.input) ??
    asString(args.script)
  );
}

function extractCwd(args: Record<string, unknown>, invocation: ToolInvocation): string | undefined {
  return (
    asString(args.cwd) ??
    asString(args.workdir) ??
    (typeof invocation.turn.cwd === "string" ? invocation.turn.cwd : undefined)
  );
}

function metadataSolanaHint(tool: Tool): boolean {
  const family = tool.metadata?.family;
  const keywords = tool.metadata?.keywords ?? [];
  return [family, ...keywords]
    .filter((value): value is string => typeof value === "string")
    .some((value) => /\bsolana\b/iu.test(value));
}

function hasTransactionWriteSignal(text: string, tool: Tool): boolean {
  if (DIRECT_TRANSACTION_TOOL_RE.test(text)) return true;
  if (SOLANA_PROGRAM_WRITE_RE.test(text)) return true;
  if (SOLANA_SIGNAL_RE.test(text) && SOLANA_WRITE_SIGNAL_RE.test(text)) {
    return true;
  }
  return metadataSolanaHint(tool) && tool.metadata?.mutating === true;
}

export function buildToolTransactionGuardInput(
  tool: Tool,
  invocation: ToolInvocation,
  args: Record<string, unknown>,
): TransactionGuardInput | null {
  const toolDisplayName = tool.name || toolNameDisplay(invocation.toolName);
  const command = extractCommand(args);
  const payloadText = logPayload(invocation.payload);
  const argsText = stringifyForScan(args);
  const metadataText = stringifyForScan(tool.metadata ?? {});
  const combined = [
    toolDisplayName,
    command ?? "",
    payloadText,
    argsText,
    metadataText,
  ].join("\n");

  // Guard iff there is a write/sign/deploy signal. This deliberately does NOT
  // short-circuit on a "read-only lookup" first: the previous ordering evaluated
  // a read-only exit before the write check, and that exit only consulted
  // SOLANA_WRITE_SIGNAL_RE (missing the direct-signing / program-write regexes),
  // so an attacker skipped the guard entirely by prefixing a signing/deploy
  // command with one read-only lookup (e.g. `solana balance && …submitTransaction(…)`).
  // hasTransactionWriteSignal already returns false for genuine read-only
  // lookups, so gating on it alone closes the whole bypass class.
  if (!hasTransactionWriteSignal(combined, tool)) {
    return null;
  }

  // Only DevNet when a devnet RPC/flag is present AND no mainnet marker is — a
  // command that names mainnet (or mixes both) is treated as mainnet, not devnet.
  const isDevnet =
    DEVNET_RPC_RE.test(combined) && !MAINNET_RPC_RE.test(combined);
  return {
    source: "tool-dispatch",
    kind: "solana_tool_invocation",
    toolName: toolDisplayName,
    callId: invocation.callId,
    cwd: extractCwd(args, invocation) ?? null,
    command: command ?? null,
    userText: command ?? payloadText,
    transactionSummary:
      `${toolDisplayName} appears to be a Solana transaction submission or signing action` +
      (isDevnet ? " targeting DevNet." : "."),
    metadata: {
      detector: {
        devnetRpcExplicit: isDevnet,
        payloadKind: invocation.payload.kind,
        toolMutating: tool.metadata?.mutating === true,
        toolSource: tool.metadata?.source ?? null,
      },
      args: sanitizeForDocket(args),
      toolMetadata: sanitizeForDocket(tool.metadata ?? {}),
    },
  };
}
