/**
 * Mobile Ledger hand-off tool.
 *
 * Core binds an exact `@ledger` mention to the active root human turn before
 * sampling. The tool turns the model's structured destination and amount into
 * a typed daemon client action; Android validates and consumes the generated
 * intent id, selects its persisted source account, and still requires physical
 * approval on the Ledger device.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { SessionConfiguration } from "../session/turn-context.js";
import {
  LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY,
  type LedgerSolanaTransferClientResult,
  type LedgerSolanaTransferClientAction,
  type RequestUserInputArgs,
  type RequestUserInputQuestion,
  type RequestUserInputResponse,
} from "./types.js";

export const REQUEST_LEDGER_TRANSFER_TOOL_NAME = "request_ledger_transfer";

export const LEDGER_ROOT_TURN_ROUTING_GUIDANCE = [
  "Trusted @ledger routing for this root-human turn only:",
  `only when the human explicitly requests a SOL transfer and both recipient and amount are unambiguous, call ${REQUEST_LEDGER_TRANSFER_TOOL_NAME} exactly once.`,
  "For balance questions, unsupported operations, or missing fields, do not invent a transfer; explain the limitation or ask for a new complete @ledger transfer request.",
  "Do not use shell commands or another wallet tool for this transfer.",
  "Convert amounts exactly: 1 SOL = 1,000,000,000 lamports, and pass lamports as a decimal integer string.",
  "A submitted receipt is not an on-chain confirmation; never describe submitted as confirmed.",
].join(" ");

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index] as const),
);
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const RESPONSE_NONCE = /^[A-Za-z0-9_-]{32,128}$/u;
const MAX_LAMPORTS = 9_223_372_036_854_775_807n;
const LEDGER_MENTION = /(^|[^\p{L}\p{N}_])@ledger(?=$|[^\p{L}\p{N}_])/iu;
const ACTION_TTL_MS = 10 * 60 * 1_000;

interface LedgerTransferInput {
  readonly to: string;
  readonly lamports: string;
  readonly note?: string;
}

interface RequestLedgerTransferSession {
  readonly sessionConfiguration: SessionConfiguration;
  currentRootHumanTurn(): {
    readonly turnId: string;
    readonly text: string;
  } | null;
  claimLedgerTransferAuthorization(turnId: string): Promise<boolean>;
  requestUserInput(
    callId: string,
    args: RequestUserInputArgs,
    signal?: AbortSignal,
  ): Promise<RequestUserInputResponse | null>;
}

export interface CreateRequestLedgerTransferToolOptions {
  readonly getSession: () => RequestLedgerTransferSession | null;
  readonly createIntentId?: () => string;
  readonly createResponseNonce?: () => string;
  readonly now?: () => number;
  readonly actionTtlMs?: number;
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function decodedBase58Length(value: string): number | null {
  if (value.length === 0) return null;
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return bytes.length + leadingZeroes -
    (bytes.length === 1 && bytes[0] === 0 ? 1 : 0);
}

function isSolanaPublicKey(value: string): boolean {
  return decodedBase58Length(value) === 32;
}

function isSolanaSignature(value: string): boolean {
  return decodedBase58Length(value) === 64;
}

function createLedgerResponseSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly expired: () => boolean;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  let didExpire = false;
  const abortFromCaller = (): void => controller.abort("ledger_request_cancelled");
  if (callerSignal?.aborted === true) abortFromCaller();
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    didExpire = true;
    controller.abort("ledger_request_expired");
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    expired: () => didExpire,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function parseInput(args: Record<string, unknown>): LedgerTransferInput {
  const to = args.to;
  const lamports = args.lamports;
  const note = args.note;
  if (typeof to !== "string" || !isSolanaPublicKey(to)) {
    throw new Error("request_ledger_transfer requires a valid Solana recipient");
  }
  if (typeof lamports !== "string" || !POSITIVE_INTEGER.test(lamports)) {
    throw new Error("request_ledger_transfer requires lamports as a positive integer string");
  }
  const parsedLamports = BigInt(lamports);
  if (parsedLamports > MAX_LAMPORTS) {
    throw new Error("request_ledger_transfer lamports exceeds the mobile signing limit");
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 240)) {
    throw new Error("request_ledger_transfer note must be at most 240 characters");
  }
  return {
    to,
    lamports,
    ...(typeof note === "string" && note.length > 0 ? { note } : {}),
  };
}

type CleanLedgerTransferResult =
  | {
      readonly type: "ledger_solana_transfer_receipt_v1";
      readonly intentId: string;
      readonly status: "submitted";
      readonly network: "mainnet-beta";
      readonly to: string;
      readonly lamports: string;
      readonly from: string;
      readonly signature: string;
      readonly confirmed: false;
    }
  | {
      readonly type: "ledger_solana_transfer_receipt_v1";
      readonly intentId: string;
      readonly status: "cancelled";
      readonly network: "mainnet-beta";
      readonly to: string;
      readonly lamports: string;
      readonly from?: string;
      readonly reason: string;
      readonly confirmed: false;
    };

function bindClientResult(
  result: LedgerSolanaTransferClientResult | undefined,
  action: LedgerSolanaTransferClientAction,
): CleanLedgerTransferResult {
  if (result === undefined) {
    throw new Error("mobile Ledger response requires a typed clientResult receipt");
  }
  if (result.intentId !== action.intentId) {
    throw new Error("mobile Ledger receipt intentId does not match this request");
  }
  if (result.responseNonce !== action.responseNonce) {
    throw new Error("mobile Ledger receipt response challenge does not match this request");
  }
  if (
    result.network !== action.network ||
    result.to !== action.to ||
    result.lamports !== action.lamports
  ) {
    throw new Error("mobile Ledger receipt transfer fields do not match this request");
  }
  if (result.from !== undefined && !isSolanaPublicKey(result.from)) {
    throw new Error("mobile Ledger receipt requires a valid Solana source address");
  }
  if (result.status === "submitted") {
    if (!isSolanaPublicKey(result.from)) {
      throw new Error("submitted mobile Ledger receipt is incomplete");
    }
    if (!isSolanaSignature(result.signature)) {
      throw new Error("mobile Ledger receipt requires a valid Solana signature");
    }
    return {
      type: result.type,
      intentId: result.intentId,
      status: result.status,
      network: result.network,
      to: result.to,
      lamports: result.lamports,
      from: result.from,
      signature: result.signature,
      confirmed: false,
    };
  }
  return {
    type: result.type,
    intentId: result.intentId,
    status: result.status,
    network: result.network,
    to: result.to,
    lamports: result.lamports,
    ...(result.from !== undefined ? { from: result.from } : {}),
    reason: result.reason,
    confirmed: false,
  };
}

function isSubagentSource(source: unknown): boolean {
  return source === "cli_subagent" ||
    (typeof source === "object" && source !== null &&
      (source as { readonly kind?: unknown }).kind === "subagent");
}

export function hasExactLedgerMention(text: string): boolean {
  return LEDGER_MENTION.test(text);
}

const INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    to: {
      type: "string",
      description: "Base58 Solana recipient address from the user's current request.",
    },
    lamports: {
      type: "string",
      description: "Exact positive integer lamport amount, encoded as a string.",
    },
    note: {
      type: "string",
      description: "Optional short human-readable reason shown on the phone.",
      maxLength: 240,
    },
  },
  required: ["to", "lamports"],
} as const);

export function createRequestLedgerTransferTool(
  opts: CreateRequestLedgerTransferToolOptions,
): Tool {
  return {
    name: REQUEST_LEDGER_TRANSFER_TOOL_NAME,
    description:
      "Route one Solana transfer to the user's AgenC Android app and wait for its result. " +
      "This succeeds only when the active root human turn contains the exact @ledger token. " +
      "The phone chooses the configured source account; never invent or override it. The " +
      "human must approve the destination and amount on the Ledger.",
    inputSchema: INPUT_SCHEMA,
    metadata: {
      family: "interaction",
      source: "builtin",
      mutating: true,
      // This is a privileged interaction/state mutation, but it never writes to a
      // model-controlled filesystem path. Without this audited exemption the runtime
      // sandbox treats the recipient/amount-only arguments as an indeterminate file write
      // and rejects the tool before the typed phone action can be emitted.
      virtualNoFsWrites: true,
      deferred: false,
      hiddenByDefault: false,
      keywords: ["ledger", "solana", "transfer", "mobile", "approval"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    supportsParallelToolCalls: false,
    // The user's exact current-turn @ledger token is the route authorization. Do not insert the
    // generic tool-approval gate before Android can receive the request; the phone validates the
    // typed action and the Ledger's physical clear-sign screen remains the signature gate.
    requiresApproval: false,
    // The exact @ledger token in this same root human turn is the authorization to route a
    // review request to the phone. Requiring the generic host approval sheet as well makes the
    // mobile flow deadlock (the agent waits on the Mac before Android can show anything). The
    // transfer still cannot sign here: Android re-validates the typed action and the human must
    // physically approve the exact transaction on the Ledger.
    requiresUserInteraction: () => false,
    recoveryCategory: "interactive",
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    timeoutBehavior: "tool",
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const session = opts.getSession();
      if (session === null) return errorResult("request_ledger_transfer requires an active session");
      if (isSubagentSource(session.sessionConfiguration.sessionSource)) {
        return errorResult("request_ledger_transfer can only be used by the root agent");
      }
      const rootHumanTurn = session.currentRootHumanTurn();
      if (
        rootHumanTurn === null ||
        !hasExactLedgerMention(rootHumanTurn.text)
      ) {
        return errorResult(
          "request_ledger_transfer requires an exact @ledger token in the active root human turn",
        );
      }

      let input: LedgerTransferInput;
      try {
        input = parseInput(args);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (!(await session.claimLedgerTransferAuthorization(rootHumanTurn.turnId))) {
        return errorResult(
          "request_ledger_transfer authorization was already consumed for this human turn",
        );
      }

      const intentId = opts.createIntentId?.() ?? `ledger_${randomUUID()}`;
      const now = opts.now?.() ?? Date.now();
      const actionTtlMs = Math.max(1, opts.actionTtlMs ?? ACTION_TTL_MS);
      const responseNonce = opts.createResponseNonce?.() ??
        randomBytes(32).toString("base64url");
      if (!RESPONSE_NONCE.test(responseNonce)) {
        return errorResult("failed to generate a valid mobile Ledger response challenge");
      }
      const clientAction: LedgerSolanaTransferClientAction = {
        type: "ledger_solana_transfer_v1",
        source: "agenc-core",
        targetCapability: LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY,
        network: "mainnet-beta",
        intentId,
        responseNonce,
        to: input.to,
        lamports: input.lamports,
        ...(input.note !== undefined ? { note: input.note } : {}),
        expiresAt: new Date(now + actionTtlMs).toISOString(),
      };
      const question: RequestUserInputQuestion = {
        id: "ledger_transfer",
        header: "Ledger",
        question: "Review and approve this Solana transfer on your Ledger device.",
        options: [],
        isOther: true,
        isSecret: false,
      };
      const injected = args as Record<string, unknown> & ToolExecutionInjectedArgs;
      const callId = typeof args.__callId === "string" && args.__callId.length > 0
        ? args.__callId
        : `ledger-transfer-${intentId}`;
      const callerSignal = injected.__abortSignal instanceof AbortSignal
        ? injected.__abortSignal
        : undefined;
      const responseWait = createLedgerResponseSignal(callerSignal, actionTtlMs);
      const response = await session.requestUserInput(
        callId,
        { questions: [question], clientAction },
        responseWait.signal,
      ).finally(responseWait.cleanup);
      if (response === null) {
        return errorResult(
          responseWait.expired()
            ? "the mobile Ledger request expired before receiving a result"
            : "the mobile Ledger request was cancelled before receiving a result",
        );
      }
      try {
        const cleanResult = bindClientResult(response.clientResult, clientAction);
        return {
          content: safeStringify(cleanResult),
          codeModeResult: cleanResult,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export const requestLedgerTransferInternals = {
  hasExactLedgerMention,
  decodedBase58Length,
  bindClientResult,
  parseInput,
};
