/**
 * Read-only Solana research for messaging gateways.
 *
 * The model never receives the Helius credential and cannot choose arbitrary
 * RPC methods. Natural-language requests are mapped to a small, typed read
 * surface, normalized here, and returned as bounded server evidence.
 */

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
);
const BASE58_CANDIDATE_RE = /[1-9A-HJ-NP-Za-km-z]{32,90}/g;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_DAILY_LIMIT = 200;
const DEFAULT_PER_PEER_LIMIT = 4;
const DEFAULT_PER_PEER_WINDOW_MS = 60_000;
const DEFAULT_REQUESTS_PER_SECOND = 8;
const DEFAULT_MAX_HOLDERS = 50;
const DEFAULT_MAX_TOKEN_ACCOUNTS_SCANNED = 50_000;
const TOKEN_ACCOUNT_SCAN_PAGE_SIZE = 5_000;
const RECENT_SWAP_WINDOW_SIZE = 20;
const RECENT_TRADES_CACHE_TTL_MS = 30_000;
const TOKEN_NET_EPSILON = 1e-12;
const MAX_SAFE_UNIX_TIMESTAMP = 4_102_444_800;
const LEGACY_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_CHARS = 12_000;
const MAX_CACHE_ENTRIES = 100;
const MAX_PEER_RATE_ENTRIES = 10_000;

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export type SolanaOnchainIntent =
  | { readonly kind: "network_summary" }
  | { readonly kind: "token_holder_age"; readonly mint?: string }
  | { readonly kind: "token_holders"; readonly mint?: string }
  | { readonly kind: "token_recent_trades"; readonly mint?: string }
  | { readonly kind: "token_summary"; readonly mint?: string }
  | { readonly kind: "wallet_summary"; readonly address?: string }
  | { readonly kind: "transaction_summary"; readonly signature?: string };

export type GatewayOnchainResult =
  | { readonly kind: "none" }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "context"; readonly context: string };

export interface GatewayOnchainFeature {
  inspect(input: {
    readonly text: string;
    readonly channelId: string;
    readonly peerId: string;
  }): Promise<GatewayOnchainResult>;
}

export interface HeliusOnchainFeatureOptions {
  readonly apiKey: string;
  readonly usageFile: string;
  readonly tokenAliases?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: Sleep;
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly dailyLimit?: number;
  readonly perPeerLimit?: number;
  readonly perPeerWindowMs?: number;
  readonly requestsPerSecond?: number;
  readonly maxHolders?: number;
  readonly maxTokenAccountsScanned?: number;
}

interface HeliusTokenAccount {
  readonly address: string;
  readonly owner: string;
  readonly amount: string;
  readonly mint?: string;
}

interface HeliusTokenAccountsResult {
  readonly last_indexed_slot?: unknown;
  readonly total?: unknown;
  readonly token_accounts?: unknown;
}

interface HeliusTransfer {
  readonly signature?: unknown;
  readonly blockTime?: unknown;
  readonly type?: unknown;
  readonly fromUserAccount?: unknown;
  readonly toUserAccount?: unknown;
  readonly mint?: unknown;
  readonly amount?: unknown;
  readonly uiAmount?: unknown;
}

interface HeliusTransfersResult {
  readonly data?: unknown;
}

interface EnhancedTokenTransfer {
  readonly mint: string;
  readonly amount: number;
  readonly fromUserAccount?: string;
  readonly toUserAccount?: string;
}

interface EnhancedNativeTransfer {
  readonly lamports: number;
  readonly fromUserAccount?: string;
  readonly toUserAccount?: string;
}

interface EnhancedSwapTransaction {
  readonly signature: string;
  readonly timestamp?: number;
  readonly source: string;
  readonly feePayer?: string;
  readonly tokenTransfers: readonly EnhancedTokenTransfer[];
  readonly nativeTransfers: readonly EnhancedNativeTransfer[];
}

interface QuoteLeg {
  readonly asset: "SOL" | "WSOL" | "USDC";
  readonly amount: number;
}

interface ProbableTokenBuy {
  readonly signature: string;
  readonly timestamp?: number;
  readonly source: string;
  readonly buyer: string;
  readonly targetAmount: number;
  readonly quoteLegs: readonly QuoteLeg[];
}

interface HolderSnapshot {
  readonly owner: string;
  readonly tokenAccount: string;
  readonly rawAmount: string;
}

interface TokenSnapshot {
  readonly holders: readonly HolderSnapshot[];
  readonly indexedSlot?: number;
  readonly totalAccounts?: number;
  readonly totalOwners?: number;
  readonly scannedAccounts: number;
  readonly completeRanking: boolean;
  readonly rankingBasis: "owner" | "token-account";
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly context: string;
}

interface DailyUsage {
  readonly day: string;
  readonly count: number;
}

class HeliusRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    options: { readonly retryable?: boolean; readonly retryAfterMs?: number } = {},
  ) {
    super(code);
    this.name = "HeliusRequestError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return bytes.length + leadingZeroes - (bytes.length === 1 && bytes[0] === 0 ? 1 : 0);
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  const encoded = digits
    .reverse()
    .map((digit) => BASE58_ALPHABET[digit])
    .join("");
  return `${"1".repeat(leadingZeroes)}${encoded === "1" && leadingZeroes > 0 ? "" : encoded}`;
}

export function isSolanaPublicKey(value: string): boolean {
  return decodedBase58Length(value) === 32;
}

export function isSolanaSignature(value: string): boolean {
  return decodedBase58Length(value) === 64;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAliasMint(
  text: string,
  aliases: Readonly<Record<string, string>>,
): string | undefined {
  for (const [alias, mint] of Object.entries(aliases)) {
    const escaped = escapeRegex(alias);
    const pattern = new RegExp(`(?:\\$|#)?${escaped}(?![a-z0-9_-])`, "iu");
    if (pattern.test(text)) return mint;
  }
  return undefined;
}

export function parseHeliusTokenAliases(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined || value.trim().length === 0) return {};
  const aliases: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("invalid Helius token alias configuration");
    }
    const alias = entry.slice(0, separator).trim().toLowerCase();
    const mint = entry.slice(separator + 1).trim();
    if (!/^[a-z0-9_-]{2,32}$/.test(alias) || !isSolanaPublicKey(mint)) {
      throw new Error("invalid Helius token alias configuration");
    }
    aliases[alias] = mint;
  }
  return aliases;
}

export function loadHeliusGatewayApiKey(input: {
  readonly enabled: boolean;
  readonly keyFile?: string;
  readonly inlineKey?: string;
}): string | undefined {
  if (!input.enabled) return undefined;
  const keyFile = input.keyFile?.trim();
  if (keyFile !== undefined && keyFile.length > 0) {
    if (!isAbsolute(keyFile)) {
      throw new Error("Helius key file must use an absolute path");
    }
    const descriptor = openSync(
      keyFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error("Helius key file must be a regular file");
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("Helius key file must not be readable by group or others");
      }
      if (stat.size < 20 || stat.size > 512) {
        throw new Error("Helius key file has an invalid size");
      }
      return validateApiKey(readFileSync(descriptor, "utf8").trim());
    } finally {
      closeSync(descriptor);
    }
  }
  const inlineKey = input.inlineKey?.trim();
  if (inlineKey === undefined || inlineKey.length === 0) {
    throw new Error("Helius on-chain research is enabled but no key is configured");
  }
  return validateApiKey(inlineKey);
}

function validateApiKey(value: string): string {
  if (value.length < 20 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Helius API key format is invalid");
  }
  return value;
}

export function parseSolanaOnchainIntent(
  text: string,
  tokenAliases: Readonly<Record<string, string>> = {},
): SolanaOnchainIntent | null {
  const normalized = text.normalize("NFKC");
  const lower = normalized.toLowerCase();
  const candidates = unique(normalized.match(BASE58_CANDIDATE_RE) ?? []);
  const publicKeys = candidates.filter(isSolanaPublicKey);
  const signatures = candidates.filter(isSolanaSignature);
  const mint = publicKeys[0] ?? findAliasMint(lower, tokenAliases);

  const mentionsTrade =
    /\b(?:buy|buys|buying|bought|purchase|purchases|swap|swaps|trade|trades|compra|compras|comprando|compr[oó]|intercambio|intercambios)\b/iu.test(
      lower,
    );
  const mentionsRecentOrLarge =
    /\b(?:latest|recent|last|newest|large|largest|big|biggest|whale|activity|[uú]ltim[oa]s?|reciente(?:s)?|nuev[oa]s?|grande(?:s)?|mayor(?:es)?|ballena(?:s)?|actividad)\b/iu.test(
      lower,
    );
  if (mentionsTrade && mentionsRecentOrLarge) {
    return { kind: "token_recent_trades", ...(mint ? { mint } : {}) };
  }

  const holderAge =
    /(?:avg|average|mean|promedio).{0,40}(?:time held|holding (?:time|age)|tiempo (?:retenido|en cartera)|antig[uü]edad)/iu.test(
      lower,
    ) ||
    /(?:time held|holding (?:time|age)|tiempo (?:retenido|en cartera)).{0,40}(?:holder|holders|tenedor|tenedores|top\s*\d+)/iu.test(
      lower,
    );
  if (holderAge) return { kind: "token_holder_age", ...(mint ? { mint } : {}) };

  if (/(?:top\s*\d+\s*)?(?:holder|holders|tenedor|tenedores)|holder concentration|holder distribution|distribuci[oó]n de tenedores/iu.test(lower)) {
    return { kind: "token_holders", ...(mint ? { mint } : {}) };
  }

  if (/(?:transaction|tx|signature|transacci[oó]n|firma).{0,24}(?:inspect|analy[sz]e|decode|review|check|revisa|analiza|decodifica)|(?:inspect|analy[sz]e|decode|review|check|revisa|analiza|decodifica).{0,24}(?:transaction|tx|signature|transacci[oó]n|firma)/iu.test(lower)) {
    const signature = signatures[0];
    return {
      kind: "transaction_summary",
      ...(signature ? { signature } : {}),
    };
  }

  if (/(?:wallet|cartera|portfolio|portafolio|balance|saldo|wallet activity|actividad de (?:wallet|cartera)|account activity)/iu.test(lower)) {
    const address = publicKeys[0];
    return { kind: "wallet_summary", ...(address ? { address } : {}) };
  }

  if (/(?:token|mint|supply|suministro|market cap|capitalizaci[oó]n).{0,32}(?:inspect|analy[sz]e|summary|info|details|revisa|analiza|resumen)|(?:inspect|analy[sz]e|summary|info|details|revisa|analiza|resumen).{0,32}(?:token|mint|supply|suministro)/iu.test(lower)) {
    return { kind: "token_summary", ...(mint ? { mint } : {}) };
  }

  if (/(?:solana).{0,32}(?:network status|chain status|current slot|block height|estado de red|slot actual|altura de bloque)|(?:network status|chain status|current slot|block height|estado de red|slot actual|altura de bloque).{0,32}(?:solana)/iu.test(lower)) {
    return { kind: "network_summary" };
  }

  return null;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(30_000, Math.round(seconds * 1_000));
}

class HeliusRpcClient {
  readonly #fetch: FetchLike;
  readonly #sleep: Sleep;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #minimumIntervalMs: number;
  #nextRequestAt = 0;
  #rateTail: Promise<void> = Promise.resolve();
  #requestId = 0;

  constructor(options: {
    readonly apiKey: string;
    readonly fetchImpl?: FetchLike;
    readonly sleep?: Sleep;
    readonly timeoutMs: number;
    readonly requestsPerSecond: number;
  }) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? sleepDefault;
    this.#apiKey = options.apiKey;
    const endpoint = new URL("https://mainnet.helius-rpc.com/");
    endpoint.searchParams.set("api-key", options.apiKey);
    this.#endpoint = endpoint.toString();
    this.#timeoutMs = options.timeoutMs;
    this.#minimumIntervalMs = Math.ceil(1_000 / options.requestsPerSecond);
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    return this.#withRetries(async () => {
      await this.#waitForRateSlot();
      return this.#fetchOnce<T>(method, params);
    });
  }

  async enhancedSwapsByAddress(address: string): Promise<unknown[]> {
    if (!isSolanaPublicKey(address)) {
      throw new HeliusRequestError("invalid_token_mint");
    }
    return this.#withRetries(async () => {
      await this.#waitForRateSlot();
      return this.#fetchEnhancedSwapsOnce(address);
    });
  }

  async #withRetries<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const safe =
          error instanceof HeliusRequestError
            ? error
            : new HeliusRequestError("network_failure", { retryable: true });
        if (!safe.retryable || attempt === 2) throw safe;
        const exponential = 500 * 2 ** attempt;
        await this.#sleep(safe.retryAfterMs ?? exponential);
      }
    }
    throw new HeliusRequestError("retry_exhausted");
  }

  async #waitForRateSlot(): Promise<void> {
    let release: (() => void) | undefined;
    const previous = this.#rateTail;
    this.#rateTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#nextRequestAt - Date.now());
      if (waitMs > 0) await this.#sleep(waitMs);
      this.#nextRequestAt = Date.now() + this.#minimumIntervalMs;
    } finally {
      release?.();
    }
  }

  async #fetchOnce<T>(method: string, params: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `agenc-${++this.#requestId}`,
          method,
          params,
        }),
        signal: controller.signal,
      });
      this.#assertHttpSuccess(response);
      const envelope = await this.#readBoundedJson(response);
      if (!isRecord(envelope)) throw new HeliusRequestError("invalid_response");
      if (isRecord(envelope.error)) {
        const code = integer(envelope.error.code);
        const retryable = code === -32005 || code === 429;
        throw new HeliusRequestError(
          code === undefined ? "rpc_error" : `rpc_error_${code}`,
          { retryable },
        );
      }
      if (!("result" in envelope)) {
        throw new HeliusRequestError("invalid_response");
      }
      return envelope.result as T;
    } catch (error) {
      if (error instanceof HeliusRequestError) throw error;
      throw new HeliusRequestError("network_failure", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async #fetchEnhancedSwapsOnce(address: string): Promise<unknown[]> {
    const endpoint = new URL(
      `https://mainnet.helius-rpc.com/v0/addresses/${address}/transactions`,
    );
    endpoint.searchParams.set("api-key", this.#apiKey);
    endpoint.searchParams.set("type", "SWAP");
    endpoint.searchParams.set("sort-order", "desc");
    endpoint.searchParams.set("limit", String(RECENT_SWAP_WINDOW_SIZE));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      this.#assertHttpSuccess(response);
      const payload = await this.#readBoundedJson(response);
      if (!Array.isArray(payload)) {
        throw new HeliusRequestError("invalid_response");
      }
      return payload.slice(0, RECENT_SWAP_WINDOW_SIZE);
    } catch (error) {
      if (error instanceof HeliusRequestError) throw error;
      throw new HeliusRequestError("network_failure", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  #assertHttpSuccess(response: Response): void {
    if (response.ok) return;
    if (
      response.status === 401 ||
      response.status === 402 ||
      response.status === 403
    ) {
      throw new HeliusRequestError("authentication_failed");
    }
    if (response.status === 429) {
      const waitMs = retryAfterMs(response);
      throw new HeliusRequestError("rate_limited", {
        retryable: true,
        ...(waitMs !== undefined ? { retryAfterMs: waitMs } : {}),
      });
    }
    if (response.status === 408 || response.status >= 500) {
      throw new HeliusRequestError("upstream_unavailable", {
        retryable: true,
      });
    }
    throw new HeliusRequestError("request_rejected");
  }

  async #readBoundedJson(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_RPC_RESPONSE_BYTES
    ) {
      throw new HeliusRequestError("response_too_large");
    }
    const text = await response.text();
    if (text.length > MAX_RPC_RESPONSE_BYTES) {
      throw new HeliusRequestError("response_too_large");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HeliusRequestError("invalid_response");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeString(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length === 0 ? undefined : clean.slice(0, maxLength);
}

function safeTokenMetadata(value: unknown, maxLength: number): string | undefined {
  const clean = safeString(value, maxLength);
  if (clean === undefined) return undefined;
  if (!/^[\p{L}\p{N} ._+&'()/:-]+$/u.test(clean)) return undefined;
  if (
    /(?:ignore|disregard|system|prompt|instruction|tool|password|secret|api[ _-]?key|execute|approve)/iu.test(
      clean,
    )
  ) {
    return undefined;
  }
  return clean;
}

function safeScalarString(value: unknown, maxLength = 64): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value).slice(0, maxLength);
  }
  return safeString(value, maxLength);
}

function positiveFiniteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" &&
          value.length <= 64 &&
          /^[0-9]+(?:\.[0-9]+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function safeUnixTimestamp(value: unknown): number | undefined {
  const timestamp = integer(value);
  return timestamp !== undefined &&
    timestamp >= 0 &&
    timestamp <= MAX_SAFE_UNIX_TIMESTAMP
    ? timestamp
    : undefined;
}

function safePublicKey(value: unknown): string | undefined {
  const address = safeString(value, 64);
  return address !== undefined && isSolanaPublicKey(address)
    ? address
    : undefined;
}

function safeSourceLabel(value: unknown): string {
  const source = safeString(value, 48);
  return source !== undefined && /^[A-Za-z0-9_-]+$/.test(source)
    ? source
    : "UNKNOWN";
}

function parseEnhancedSwapTransactions(
  payload: readonly unknown[],
): EnhancedSwapTransaction[] {
  const transactions: EnhancedSwapTransaction[] = [];
  for (const item of payload.slice(0, RECENT_SWAP_WINDOW_SIZE)) {
    if (!isRecord(item) || safeString(item.type, 16)?.toUpperCase() !== "SWAP") {
      continue;
    }
    const transactionSignature = safeString(item.signature, 96);
    if (
      transactionSignature === undefined ||
      !isSolanaSignature(transactionSignature)
    ) {
      continue;
    }
    const tokenTransfers: EnhancedTokenTransfer[] = [];
    if (Array.isArray(item.tokenTransfers)) {
      for (const transfer of item.tokenTransfers.slice(0, 100)) {
        if (!isRecord(transfer)) continue;
        const mint = safePublicKey(transfer.mint);
        const amount = positiveFiniteNumber(transfer.tokenAmount);
        const fromUserAccount = safePublicKey(transfer.fromUserAccount);
        const toUserAccount = safePublicKey(transfer.toUserAccount);
        if (
          mint === undefined ||
          amount === undefined ||
          (fromUserAccount === undefined && toUserAccount === undefined)
        ) {
          continue;
        }
        tokenTransfers.push({
          mint,
          amount,
          ...(fromUserAccount !== undefined ? { fromUserAccount } : {}),
          ...(toUserAccount !== undefined ? { toUserAccount } : {}),
        });
      }
    }
    const nativeTransfers: EnhancedNativeTransfer[] = [];
    if (Array.isArray(item.nativeTransfers)) {
      for (const transfer of item.nativeTransfers.slice(0, 100)) {
        if (!isRecord(transfer)) continue;
        const lamports = positiveFiniteNumber(transfer.amount);
        const fromUserAccount = safePublicKey(transfer.fromUserAccount);
        const toUserAccount = safePublicKey(transfer.toUserAccount);
        if (
          lamports === undefined ||
          !Number.isSafeInteger(lamports) ||
          (fromUserAccount === undefined && toUserAccount === undefined)
        ) {
          continue;
        }
        nativeTransfers.push({
          lamports,
          ...(fromUserAccount !== undefined ? { fromUserAccount } : {}),
          ...(toUserAccount !== undefined ? { toUserAccount } : {}),
        });
      }
    }
    const feePayer = safePublicKey(item.feePayer);
    const timestamp = safeUnixTimestamp(item.timestamp);
    transactions.push({
      signature: transactionSignature,
      ...(timestamp !== undefined ? { timestamp } : {}),
      source: safeSourceLabel(item.source),
      ...(feePayer !== undefined ? { feePayer } : {}),
      tokenTransfers,
      nativeTransfers,
    });
  }
  return transactions;
}

function addNetAmount(
  nets: Map<string, Map<string, number>>,
  account: string | undefined,
  mint: string,
  delta: number,
): void {
  if (account === undefined) return;
  const accountNets = nets.get(account) ?? new Map<string, number>();
  accountNets.set(mint, (accountNets.get(mint) ?? 0) + delta);
  nets.set(account, accountNets);
}

function addNativeNetAmount(
  nets: Map<string, number>,
  account: string | undefined,
  delta: number,
): void {
  if (account === undefined) return;
  nets.set(account, (nets.get(account) ?? 0) + delta);
}

function classifyProbableTokenBuys(
  transactions: readonly EnhancedSwapTransaction[],
  targetMint: string,
): {
  readonly targetMatchedTransactions: number;
  readonly buys: readonly ProbableTokenBuy[];
} {
  let targetMatchedTransactions = 0;
  const buys: ProbableTokenBuy[] = [];
  for (const transaction of transactions) {
    if (!transaction.tokenTransfers.some((transfer) => transfer.mint === targetMint)) {
      continue;
    }
    targetMatchedTransactions += 1;
    const tokenNets = new Map<string, Map<string, number>>();
    for (const transfer of transaction.tokenTransfers) {
      addNetAmount(
        tokenNets,
        transfer.fromUserAccount,
        transfer.mint,
        -transfer.amount,
      );
      addNetAmount(
        tokenNets,
        transfer.toUserAccount,
        transfer.mint,
        transfer.amount,
      );
    }
    const nativeNets = new Map<string, number>();
    for (const transfer of transaction.nativeTransfers) {
      addNativeNetAmount(
        nativeNets,
        transfer.fromUserAccount,
        -transfer.lamports,
      );
      addNativeNetAmount(
        nativeNets,
        transfer.toUserAccount,
        transfer.lamports,
      );
    }

    for (const [account, accountNets] of tokenNets) {
      const targetAmount = accountNets.get(targetMint) ?? 0;
      if (
        targetAmount <= TOKEN_NET_EPSILON ||
        transaction.feePayer !== account
      ) {
        continue;
      }
      const quoteLegs: QuoteLeg[] = [];
      if (targetMint !== WRAPPED_SOL_MINT) {
        const wrappedSolOutflow = -(accountNets.get(WRAPPED_SOL_MINT) ?? 0);
        if (wrappedSolOutflow > TOKEN_NET_EPSILON) {
          quoteLegs.push({ asset: "WSOL", amount: wrappedSolOutflow });
        }
      }
      if (targetMint !== USDC_MINT) {
        const usdcOutflow = -(accountNets.get(USDC_MINT) ?? 0);
        if (usdcOutflow > TOKEN_NET_EPSILON) {
          quoteLegs.push({ asset: "USDC", amount: usdcOutflow });
        }
      }
      if (quoteLegs.length === 0) {
        const nativeOutflowLamports = -(nativeNets.get(account) ?? 0);
        if (nativeOutflowLamports > 0) {
          quoteLegs.push({
            asset: "SOL",
            amount: nativeOutflowLamports / 1_000_000_000,
          });
        }
      }
      if (quoteLegs.length === 0) continue;
      buys.push({
        signature: transaction.signature,
        ...(transaction.timestamp !== undefined
          ? { timestamp: transaction.timestamp }
          : {}),
        source: transaction.source,
        buyer: account,
        targetAmount,
        quoteLegs,
      });
    }
  }
  return {
    targetMatchedTransactions,
    buys: buys.sort(
      (left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0),
    ),
  };
}

function formatObservedAmount(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

function formatQuoteLegs(legs: readonly QuoteLeg[]): string {
  return legs
    .map((leg) => `${formatObservedAmount(leg.amount)} ${leg.asset}`)
    .join(" + ");
}

function positiveIntegerString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value > 0n ? value.toString() : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value).toString();
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n) {
    return value;
  }
  return undefined;
}

function parseTokenAccounts(result: HeliusTokenAccountsResult): HeliusTokenAccount[] {
  if (!Array.isArray(result.token_accounts)) return [];
  const accounts: HeliusTokenAccount[] = [];
  for (const item of result.token_accounts) {
    if (!isRecord(item)) continue;
    const address = safeString(item.address, 64);
    const owner = safeString(item.owner, 64);
    const mint = safeString(item.mint, 64);
    const amount = positiveIntegerString(item.amount);
    if (
      address === undefined ||
      owner === undefined ||
      amount === undefined ||
      !isSolanaPublicKey(address) ||
      !isSolanaPublicKey(owner)
    ) {
      continue;
    }
    accounts.push({
      address,
      owner,
      amount,
      ...(mint !== undefined && isSolanaPublicKey(mint) ? { mint } : {}),
    });
  }
  return accounts;
}

function decodeBase64AccountData(value: unknown): Uint8Array | undefined {
  const encoded =
    Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : typeof value === "string"
        ? value
        : undefined;
  if (encoded === undefined || encoded.length > 512) return undefined;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return undefined;
  }
}

function littleEndianU64(bytes: Uint8Array, offset: number): bigint | undefined {
  if (bytes.length < offset + 8) return undefined;
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function parseProgramTokenAccount(item: unknown): HeliusTokenAccount | undefined {
  if (!isRecord(item)) return undefined;
  const address = safeString(item.pubkey, 64);
  const account = isRecord(item.account) ? item.account : undefined;
  const data = decodeBase64AccountData(account?.data);
  if (
    address === undefined ||
    !isSolanaPublicKey(address) ||
    data === undefined ||
    data.length < 40
  ) {
    return undefined;
  }
  const owner = encodeBase58(data.slice(0, 32));
  const amount = littleEndianU64(data, 32);
  if (!isSolanaPublicKey(owner) || amount === undefined || amount <= 0n) {
    return undefined;
  }
  return { address, owner, amount: amount.toString() };
}

function parseAccountOwner(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const data = decodeBase64AccountData(item.data);
  if (data === undefined || data.length < 32) return undefined;
  const owner = encodeBase58(data.slice(0, 32));
  return isSolanaPublicKey(owner) ? owner : undefined;
}

function aggregateHolders(
  accounts: readonly HeliusTokenAccount[],
  limit: number,
): HolderSnapshot[] {
  const byOwner = new Map<
    string,
    { amount: bigint; tokenAccount: string }
  >();
  for (const account of accounts) {
    const existing = byOwner.get(account.owner);
    const amount = BigInt(account.amount);
    if (existing === undefined) {
      byOwner.set(account.owner, { amount, tokenAccount: account.address });
    } else {
      existing.amount += amount;
      if (amount > existing.amount - amount) existing.tokenAccount = account.address;
    }
  }
  return [...byOwner.entries()]
    .sort((left, right) =>
      left[1].amount === right[1].amount
        ? 0
        : left[1].amount > right[1].amount
          ? -1
          : 1,
    )
    .slice(0, limit)
    .map(([owner, value]) => ({
      owner,
      tokenAccount: value.tokenAccount,
      rawAmount: value.amount.toString(),
    }));
}

function formatRawAmount(rawAmount: string, decimals: number): string {
  if (decimals <= 0) return rawAmount;
  const padded = rawAmount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function percentage(part: bigint, total: bigint): string | undefined {
  if (total <= 0n) return undefined;
  const hundredths = (part * 10_000n) / total;
  return `${Number(hundredths) / 100}%`;
}

function shorten(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function dayString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function readDailyUsage(path: string, nowMs: number): DailyUsage {
  const day = dayString(nowMs);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      isRecord(parsed) &&
      parsed.day === day &&
      typeof parsed.count === "number" &&
      Number.isSafeInteger(parsed.count) &&
      parsed.count >= 0
    ) {
      return { day, count: parsed.count };
    }
  } catch {
    // Missing or corrupt usage state resets only the current day counter.
  }
  return { day, count: 0 };
}

function writeDailyUsage(path: string, usage: DailyUsage): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(usage), { mode: 0o600 });
  renameSync(temporary, path);
}

function intentTarget(intent: SolanaOnchainIntent): string {
  switch (intent.kind) {
    case "network_summary":
      return "solana-mainnet";
    case "token_holder_age":
    case "token_holders":
    case "token_recent_trades":
    case "token_summary":
      return intent.mint ?? "missing";
    case "wallet_summary":
      return intent.address ?? "missing";
    case "transaction_summary":
      return intent.signature ?? "missing";
  }
}

function intentCost(intent: SolanaOnchainIntent): number {
  return intent.kind === "token_holder_age"
    ? 10
    : intent.kind === "token_recent_trades"
      ? 5
      : intent.kind === "network_summary"
        ? 1
        : 2;
}

function missingTargetReply(intent: SolanaOnchainIntent): string | undefined {
  switch (intent.kind) {
    case "network_summary":
      return undefined;
    case "token_holder_age":
    case "token_holders":
    case "token_recent_trades":
    case "token_summary":
      return intent.mint === undefined
        ? "Send the exact Solana token mint (or a verified Solscan link) so I can read the chain without guessing the asset."
        : undefined;
    case "wallet_summary":
      return intent.address === undefined
        ? "Send the exact Solana wallet address so I can inspect its public on-chain state."
        : undefined;
    case "transaction_summary":
      return intent.signature === undefined
        ? "Send the exact Solana transaction signature so I can inspect it."
        : undefined;
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof HeliusRequestError ? error.code : "unexpected_failure";
}

function publicErrorReply(error: unknown): string {
  const code = safeErrorCode(error);
  if (code === "holder_ranking_too_large") {
    return "This token is too large for a bounded exact holder ranking through the current indexer. I will not fake top-25/top-50 numbers; use a dedicated holder index or ask about a smaller mint.";
  }
  if (code === "authentication_failed") {
    return "Live Solana data is temporarily unavailable. The server-side data credential needs attention; no secret was exposed.";
  }
  if (
    code === "rate_limited" ||
    code === "upstream_unavailable" ||
    code === "network_failure" ||
    code === "retry_exhausted"
  ) {
    return "Solana data is busy upstream right now. Try the same question again in a minute.";
  }
  return "I could not complete that live Solana read safely. Check the mint, wallet, or transaction id and try again.";
}

function truncateEvidence(value: string): string {
  if (value.length <= MAX_EVIDENCE_CHARS) return value;
  const sliced = value.slice(0, MAX_EVIDENCE_CHARS);
  const lastNewline = sliced.lastIndexOf("\n");
  return `${sliced.slice(0, Math.max(0, lastNewline))}\n[evidence truncated]`;
}

export class HeliusOnchainFeature implements GatewayOnchainFeature {
  readonly #rpc: HeliusRpcClient;
  readonly #usageFile: string;
  readonly #aliases: Readonly<Record<string, string>>;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #cacheTtlMs: number;
  readonly #dailyLimit: number;
  readonly #perPeerLimit: number;
  readonly #perPeerWindowMs: number;
  readonly #maxHolders: number;
  readonly #maxTokenAccountsScanned: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #peerRequests = new Map<string, number[]>();

  constructor(options: HeliusOnchainFeatureOptions) {
    this.#usageFile = options.usageFile;
    this.#aliases = options.tokenAliases ?? {};
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#dailyLimit = options.dailyLimit ?? DEFAULT_DAILY_LIMIT;
    this.#perPeerLimit = options.perPeerLimit ?? DEFAULT_PER_PEER_LIMIT;
    this.#perPeerWindowMs =
      options.perPeerWindowMs ?? DEFAULT_PER_PEER_WINDOW_MS;
    this.#maxHolders = Math.max(
      1,
      Math.min(
        DEFAULT_MAX_HOLDERS,
        options.maxHolders ?? DEFAULT_MAX_HOLDERS,
      ),
    );
    this.#maxTokenAccountsScanned = Math.max(
      this.#maxHolders,
      Math.min(
        100_000,
        options.maxTokenAccountsScanned ?? DEFAULT_MAX_TOKEN_ACCOUNTS_SCANNED,
      ),
    );
    this.#rpc = new HeliusRpcClient({
      apiKey: validateApiKey(options.apiKey),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      requestsPerSecond:
        options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND,
    });
  }

  async inspect(input: {
    readonly text: string;
    readonly channelId: string;
    readonly peerId: string;
  }): Promise<GatewayOnchainResult> {
    const intent = parseSolanaOnchainIntent(input.text, this.#aliases);
    if (intent === null) return { kind: "none" };
    const missing = missingTargetReply(intent);
    if (missing !== undefined) return { kind: "reply", text: missing };

    const nowMs = this.#now();
    if (!this.#admitPeer(`${input.channelId}:${input.peerId}`, nowMs)) {
      return {
        kind: "reply",
        text: "Too many live chain reads from this account. Give it a minute and try again.",
      };
    }

    const cacheKey = `${intent.kind}:${intentTarget(intent)}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > nowMs) {
      return { kind: "context", context: cached.context };
    }

    const existing = this.#inflight.get(cacheKey);
    if (existing !== undefined) {
      try {
        return { kind: "context", context: await existing };
      } catch (error) {
        return { kind: "reply", text: publicErrorReply(error) };
      }
    }

    const cost = intentCost(intent);
    const usage = readDailyUsage(this.#usageFile, nowMs);
    if (usage.count + cost > this.#dailyLimit) {
      return {
        kind: "reply",
        text: "The public on-chain research budget is full for today. Try again after the daily reset.",
      };
    }
    writeDailyUsage(this.#usageFile, { day: usage.day, count: usage.count + cost });

    const request = this.#buildEvidence(intent, nowMs);
    this.#inflight.set(cacheKey, request);
    try {
      const context = truncateEvidence(await request);
      const cacheTtlMs =
        intent.kind === "token_recent_trades"
          ? Math.min(this.#cacheTtlMs, RECENT_TRADES_CACHE_TTL_MS)
          : this.#cacheTtlMs;
      this.#remember(cacheKey, { expiresAt: nowMs + cacheTtlMs, context });
      return { kind: "context", context };
    } catch (error) {
      this.#log(
        `gateway onchain: read failed (${intent.kind}, ${safeErrorCode(error)})`,
      );
      return { kind: "reply", text: publicErrorReply(error) };
    } finally {
      this.#inflight.delete(cacheKey);
    }
  }

  #admitPeer(peerKey: string, nowMs: number): boolean {
    if (
      !this.#peerRequests.has(peerKey) &&
      this.#peerRequests.size >= MAX_PEER_RATE_ENTRIES
    ) {
      const oldest = this.#peerRequests.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#peerRequests.delete(oldest);
    }
    const cutoff = nowMs - this.#perPeerWindowMs;
    const recent = (this.#peerRequests.get(peerKey) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= this.#perPeerLimit) {
      this.#peerRequests.set(peerKey, recent);
      return false;
    }
    recent.push(nowMs);
    this.#peerRequests.set(peerKey, recent);
    return true;
  }

  #remember(key: string, entry: CacheEntry): void {
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, entry);
  }

  async #buildEvidence(
    intent: SolanaOnchainIntent,
    observedAtMs: number,
  ): Promise<string> {
    switch (intent.kind) {
      case "network_summary":
        return this.#networkSummary(observedAtMs);
      case "token_holder_age":
        return this.#tokenHolderAge(intent.mint!, observedAtMs);
      case "token_holders":
        return this.#tokenHolders(intent.mint!, observedAtMs);
      case "token_recent_trades":
        return this.#tokenRecentTrades(intent.mint!, observedAtMs);
      case "token_summary":
        return this.#tokenSummary(intent.mint!, observedAtMs);
      case "wallet_summary":
        return this.#walletSummary(intent.address!, observedAtMs);
      case "transaction_summary":
        return this.#transactionSummary(intent.signature!, observedAtMs);
    }
  }

  async #tokenSnapshot(mint: string): Promise<TokenSnapshot> {
    const mintAccount = await this.#rpc.call<Record<string, unknown>>(
      "getAccountInfo",
      [mint, { commitment: "finalized", encoding: "base64" }],
    );
    const mintValue = isRecord(mintAccount.value) ? mintAccount.value : undefined;
    const tokenProgram = safeString(mintValue?.owner, 64);
    if (tokenProgram === undefined || !isSolanaPublicKey(tokenProgram)) {
      throw new HeliusRequestError("invalid_token_mint");
    }

    const scanned: HeliusTokenAccount[] = [];
    let examinedAccounts = 0;
    let scannedPages = 0;
    let paginationKey: string | null | undefined;
    let completeRanking = false;
    const seenPaginationKeys = new Set<string>();
    const maxScanPages = Math.min(
      25,
      Math.ceil(
        this.#maxTokenAccountsScanned / TOKEN_ACCOUNT_SCAN_PAGE_SIZE,
      ) + 5,
    );
    while (
      examinedAccounts < this.#maxTokenAccountsScanned &&
      scannedPages < maxScanPages
    ) {
      scannedPages += 1;
      const remaining = this.#maxTokenAccountsScanned - examinedAccounts;
      const page = await this.#rpc.call<Record<string, unknown>>(
        "getProgramAccountsV2",
        [
          tokenProgram,
          {
            commitment: "finalized",
            encoding: "base64",
            dataSlice: { offset: 32, length: 40 },
            limit: Math.min(TOKEN_ACCOUNT_SCAN_PAGE_SIZE, remaining),
            ...(paginationKey !== undefined ? { paginationKey } : {}),
            filters: [
              ...(tokenProgram === LEGACY_TOKEN_PROGRAM_ID
                ? [{ dataSize: 165 }]
                : []),
              { memcmp: { offset: 0, bytes: mint } },
            ],
          },
        ],
      );
      const payload = isRecord(page.value) ? page.value : page;
      const pageAccounts = Array.isArray(payload.accounts)
        ? payload.accounts
        : [];
      examinedAccounts += pageAccounts.length;
      for (const item of pageAccounts) {
        const parsed = parseProgramTokenAccount(item);
        if (parsed !== undefined) scanned.push(parsed);
      }
      const next =
        payload.paginationKey === null
          ? null
          : safeString(payload.paginationKey, 128);
      if (next === null) {
        completeRanking = true;
        break;
      }
      if (next === undefined || seenPaginationKeys.has(next)) break;
      seenPaginationKeys.add(next);
      paginationKey = next;
    }

    if (completeRanking) {
      return {
        holders: aggregateHolders(scanned, this.#maxHolders),
        totalAccounts: scanned.length,
        totalOwners: new Set(scanned.map((account) => account.owner)).size,
        scannedAccounts: examinedAccounts,
        completeRanking: true,
        rankingBasis: "owner",
      };
    }
    try {
      return await this.#largestTokenAccounts(mint, examinedAccounts);
    } catch (error) {
      if (
        error instanceof HeliusRequestError &&
        error.code === "rpc_error_-32600"
      ) {
        throw new HeliusRequestError("holder_ranking_too_large");
      }
      throw error;
    }
  }

  async #largestTokenAccounts(
    mint: string,
    scannedAccounts: number,
  ): Promise<TokenSnapshot> {
    const largest = await this.#rpc.call<Record<string, unknown>>(
      "getTokenLargestAccounts",
      [mint, { commitment: "finalized" }],
    );
    const values = Array.isArray(largest.value) ? largest.value : [];
    const rows = values
      .map((item) => {
        if (!isRecord(item)) return undefined;
        const address = safeString(item.address, 64);
        const amount = positiveIntegerString(item.amount);
        return address !== undefined &&
          amount !== undefined &&
          isSolanaPublicKey(address)
          ? { address, amount }
          : undefined;
      })
      .filter(
        (value): value is { readonly address: string; readonly amount: string } =>
          value !== undefined,
      );
    if (rows.length === 0) throw new HeliusRequestError("no_token_holders");

    const ownerAccounts = await this.#rpc.call<Record<string, unknown>>(
      "getMultipleAccounts",
      [
        rows.map((row) => row.address),
        {
          commitment: "finalized",
          encoding: "base64",
          dataSlice: { offset: 32, length: 32 },
        },
      ],
    );
    const owners = Array.isArray(ownerAccounts.value) ? ownerAccounts.value : [];
    const mappedAccounts = rows.flatMap((row, index) => {
      const owner = parseAccountOwner(owners[index]);
      return owner === undefined
        ? []
        : [
            {
              address: row.address,
              owner,
              amount: row.amount,
            },
          ];
    });
    const holders = aggregateHolders(mappedAccounts, this.#maxHolders);
    if (holders.length === 0) throw new HeliusRequestError("no_token_holders");
    const context = isRecord(largest.context) ? largest.context : undefined;
    return {
      holders,
      ...(integer(context?.slot) !== undefined
        ? { indexedSlot: integer(context?.slot) }
        : {}),
      scannedAccounts,
      completeRanking: false,
      rankingBasis: "token-account",
    };
  }

  async #optional<T>(method: string, params: unknown): Promise<T | undefined> {
    try {
      return await this.#rpc.call<T>(method, params);
    } catch {
      return undefined;
    }
  }

  async #tokenIdentity(mint: string): Promise<{
    readonly name?: string;
    readonly symbol?: string;
  }> {
    const asset = await this.#optional<Record<string, unknown>>("getAsset", {
      id: mint,
      displayOptions: { showFungible: true },
    });
    if (!isRecord(asset)) return {};
    const content = isRecord(asset.content) ? asset.content : undefined;
    const metadata = isRecord(content?.metadata) ? content.metadata : undefined;
    const tokenInfo = isRecord(asset.token_info) ? asset.token_info : undefined;
    const name = safeTokenMetadata(metadata?.name, 80);
    const symbol = safeTokenMetadata(tokenInfo?.symbol ?? metadata?.symbol, 24);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    };
  }

  async #tokenSupply(mint: string): Promise<{
    readonly rawAmount?: string;
    readonly decimals: number;
  }> {
    const supply = await this.#optional<Record<string, unknown>>("getTokenSupply", [
      mint,
      { commitment: "finalized" },
    ]);
    const value = isRecord(supply?.value) ? supply.value : undefined;
    return {
      ...(positiveIntegerString(value?.amount) !== undefined
        ? { rawAmount: positiveIntegerString(value?.amount) }
        : {}),
      decimals: integer(value?.decimals) ?? 0,
    };
  }

  async #tokenHolderAge(mint: string, observedAtMs: number): Promise<string> {
    const [snapshot, identity, supply] = await Promise.all([
      this.#tokenSnapshot(mint),
      this.#tokenIdentity(mint),
      this.#tokenSupply(mint),
    ]);
    if (snapshot.holders.length === 0) {
      throw new HeliusRequestError("no_token_holders");
    }

    const ages = await Promise.all(
      snapshot.holders.map(async (holder) => {
        try {
          const transfers = await this.#rpc.call<HeliusTransfersResult>(
            "getTransfersByAddress",
            [
              holder.owner,
              {
                mint,
                direction: "in",
                sortOrder: "asc",
                commitment: "finalized",
                limit: 1,
              },
            ],
          );
          const data = Array.isArray(transfers.data)
            ? (transfers.data as HeliusTransfer[])
            : [];
          const blockTime = data
            .map((transfer) => integer(transfer.blockTime))
            .find((value): value is number => value !== undefined);
          if (blockTime === undefined) return undefined;
          return Math.max(0, observedAtMs / 1_000 - blockTime) / 86_400;
        } catch {
          return undefined;
        }
      }),
    );

    const label = identity.symbol ?? identity.name ?? shorten(mint);
    const lines = [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: token holder age estimate",
      `Token: ${label}`,
      `Mint: ${mint}`,
      `Token accounts examined: ${snapshot.totalAccounts ?? `at least ${snapshot.scannedAccounts}`}`,
      ...(snapshot.totalOwners !== undefined
        ? [`Distinct current owners found: ${snapshot.totalOwners}`]
        : []),
      `Ranked entries sampled: ${snapshot.holders.length}`,
      `Ranking basis: ${snapshot.rankingBasis === "owner" ? "aggregated wallet owners" : "top token accounts (full owner ranking exceeded scan cap)"}`,
      ...(snapshot.indexedSlot !== undefined
        ? [`Indexed through slot: ${snapshot.indexedSlot}`]
        : []),
    ];
    for (const requested of [10, 25, 50]) {
      if (!snapshot.completeRanking && requested > snapshot.holders.length) {
        lines.push(
          `Top ${requested}: unavailable; an exact owner ranking exceeded the bounded ${snapshot.scannedAccounts}-account scan and Solana's largest-account RPC returns only 20 token accounts`,
        );
        continue;
      }
      const sampled = Math.min(requested, ages.length);
      const known = ages.slice(0, sampled).filter(
        (age): age is number => age !== undefined,
      );
      if (known.length === 0) {
        lines.push(
          `Top ${requested}: average unavailable; observed inbound coverage 0/${sampled}`,
        );
        continue;
      }
      const average = known.reduce((sum, value) => sum + value, 0) / known.length;
      const sorted = [...known].sort((left, right) => left - right);
      const median =
        sorted.length % 2 === 1
          ? sorted[Math.floor(sorted.length / 2)]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      lines.push(
        `Top ${requested}: average ${average.toFixed(1)} days; median ${median.toFixed(1)} days; observed inbound coverage ${known.length}/${sampled}`,
      );
    }
    if (supply.rawAmount !== undefined) {
      lines.push(
        `Finalized token supply: ${formatRawAmount(supply.rawAmount, supply.decimals)}`,
      );
    }
    lines.push(
      snapshot.rankingBasis === "owner"
        ? "Method: current top owner balances, then each owner's earliest inbound transfer for this mint returned by Helius."
        : "Method: largest token accounts mapped to owners, then each owner's earliest inbound transfer for this mint returned by Helius.",
      "Important limitation: this is an estimated first-observed acquisition age, not FIFO lot age. Helius getTransfersByAddress currently retains one year; holders without an observed inbound transfer are excluded and coverage is shown.",
      "No exchange, liquidity-pool, treasury, burn, or program-owned addresses were removed unless separately labeled.",
      ...(snapshot.completeRanking
        ? []
        : [
            "Large-token fallback: only the standard top-20 token-account ranking is exact; top-25/top-50 owner metrics are intentionally withheld.",
          ]),
    );
    return lines.join("\n");
  }

  async #tokenHolders(mint: string, observedAtMs: number): Promise<string> {
    const [snapshot, identity, supply] = await Promise.all([
      this.#tokenSnapshot(mint),
      this.#tokenIdentity(mint),
      this.#tokenSupply(mint),
    ]);
    if (snapshot.holders.length === 0) {
      throw new HeliusRequestError("no_token_holders");
    }
    const label = identity.symbol ?? identity.name ?? shorten(mint);
    const supplyRaw = supply.rawAmount === undefined ? undefined : BigInt(supply.rawAmount);
    const lines = [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: token holder snapshot",
      `Token: ${label}`,
      `Mint: ${mint}`,
      `Token accounts examined: ${snapshot.totalAccounts ?? `at least ${snapshot.scannedAccounts}`}`,
      ...(snapshot.totalOwners !== undefined
        ? [`Distinct current owners found: ${snapshot.totalOwners}`]
        : []),
      `Ranking basis: ${snapshot.rankingBasis === "owner" ? "aggregated wallet owners" : "top token accounts (full owner ranking exceeded scan cap)"}`,
      ...(snapshot.indexedSlot !== undefined
        ? [`Indexed through slot: ${snapshot.indexedSlot}`]
        : []),
    ];
    for (const requested of [10, 25, 50]) {
      if (!snapshot.completeRanking && requested > snapshot.holders.length) {
        lines.push(
          `Top ${requested} concentration: unavailable beyond the standard top-${snapshot.holders.length} token-account fallback`,
        );
        continue;
      }
      const holders = snapshot.holders.slice(0, requested);
      const total = holders.reduce((sum, holder) => sum + BigInt(holder.rawAmount), 0n);
      lines.push(
        `Top ${requested} concentration: ${supplyRaw === undefined ? "supply unavailable" : percentage(total, supplyRaw)}`,
      );
    }
    lines.push(
      snapshot.rankingBasis === "owner"
        ? "Largest current owners:"
        : "Largest token accounts mapped to owners:",
    );
    snapshot.holders.slice(0, 10).forEach((holder, index) => {
      lines.push(
        `${index + 1}. ${holder.owner} - ${formatRawAmount(holder.rawAmount, supply.decimals)} tokens`,
      );
    });
    lines.push(
      "The owner list is public chain data. Exchange, LP, treasury, burn, and program-controlled addresses are not automatically excluded.",
    );
    return lines.join("\n");
  }

  async #tokenRecentTrades(
    mint: string,
    observedAtMs: number,
  ): Promise<string> {
    const payload = await this.#rpc.enhancedSwapsByAddress(mint);
    const transactions = parseEnhancedSwapTransactions(payload);
    const classified = classifyProbableTokenBuys(transactions, mint);
    const lines = [
      "Source: Helius read-only Solana mainnet enhanced transactions",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: recent probable token buys",
      `Mint: ${mint}`,
      `Search window: latest ${RECENT_SWAP_WINDOW_SIZE} Helius-indexed SWAP rows for the mint address`,
      `Valid SWAP rows returned: ${transactions.length}`,
      `Rows containing the target mint: ${classified.targetMatchedTransactions}`,
      `Probable buyer legs found: ${classified.buys.length}`,
    ];

    if (classified.buys.length > 0) {
      lines.push("Newest probable buys:");
      for (const buy of classified.buys.slice(0, 10)) {
        lines.push(
          `- ${buy.timestamp === undefined ? "time unknown" : new Date(buy.timestamp * 1_000).toISOString()} | buyer ${buy.buyer} | received ${formatObservedAmount(buy.targetAmount)} target tokens | paid ${formatQuoteLegs(buy.quoteLegs)} | source ${buy.source} | signature ${buy.signature}`,
        );
      }

      const largestByQuote = new Map<
        QuoteLeg["asset"],
        { readonly buy: ProbableTokenBuy; readonly leg: QuoteLeg }
      >();
      for (const buy of classified.buys) {
        for (const leg of buy.quoteLegs) {
          const current = largestByQuote.get(leg.asset);
          if (current === undefined || leg.amount > current.leg.amount) {
            largestByQuote.set(leg.asset, { buy, leg });
          }
        }
      }
      lines.push("Largest probable buy in this returned window by quote asset:");
      for (const asset of ["SOL", "WSOL", "USDC"] as const) {
        const largest = largestByQuote.get(asset);
        if (largest === undefined) continue;
        lines.push(
          `- ${formatObservedAmount(largest.leg.amount)} ${asset} paid for ${formatObservedAmount(largest.buy.targetAmount)} target tokens | buyer ${largest.buy.buyer} | ${largest.buy.timestamp === undefined ? "time unknown" : new Date(largest.buy.timestamp * 1_000).toISOString()} | signature ${largest.buy.signature}`,
        );
      }
    } else {
      lines.push(
        "No probable buy met the conservative same-account classification in the returned window.",
      );
    }

    lines.push(
      "Classification rule: the transaction fee payer must be the same public account with a net target-token inflow and a net SOL, WSOL, or USDC outflow in the indexed swap.",
      "Limitations: sponsored, router, aggregator, pool, transfer-tax, or multi-account flows can be missed or split. These are probable buys, not definitive beneficial-owner attribution.",
      "SOL, WSOL, and USDC sizes are reported separately; no cross-asset size comparison or USD conversion was invented.",
      "Only typed addresses, amounts, timestamps, sources, and signatures were retained. Helius descriptions, logs, memos, and arbitrary instruction text were excluded from model context.",
    );
    return lines.join("\n");
  }

  async #tokenSummary(mint: string, observedAtMs: number): Promise<string> {
    const [identity, supply, snapshot] = await Promise.all([
      this.#tokenIdentity(mint),
      this.#tokenSupply(mint),
      this.#tokenSnapshot(mint).catch(() => undefined),
    ]);
    const topTenRaw = snapshot?.holders
      .slice(0, 10)
      .reduce((sum, holder) => sum + BigInt(holder.rawAmount), 0n);
    const supplyRaw = supply.rawAmount === undefined ? undefined : BigInt(supply.rawAmount);
    const concentration =
      topTenRaw === undefined || supplyRaw === undefined
        ? "unavailable"
        : percentage(topTenRaw, supplyRaw);
    return [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: token summary",
      `Name: ${identity.name ?? "unknown"}`,
      `Symbol: ${identity.symbol ?? "unknown"}`,
      `Mint: ${mint}`,
      `Finalized supply: ${supply.rawAmount === undefined ? "unknown" : formatRawAmount(supply.rawAmount, supply.decimals)}`,
      `Decimals: ${supply.decimals}`,
      `Holder ranking scope: ${snapshot === undefined ? "unavailable" : snapshot.totalOwners !== undefined ? `${snapshot.totalOwners} distinct owners from ${snapshot.totalAccounts ?? snapshot.scannedAccounts} token accounts` : `top token-account fallback after examining at least ${snapshot.scannedAccounts} accounts`}`,
      `${snapshot?.rankingBasis === "token-account" ? "Top 10 token-account concentration" : "Top 10 owner concentration"}: ${concentration}`,
      ...(snapshot?.indexedSlot !== undefined
        ? [`Indexed through slot: ${snapshot.indexedSlot}`]
        : []),
      ...(snapshot === undefined
        ? [
            "Holder ranking is unavailable for this token through the current bounded indexer; no partial ranking was reported.",
          ]
        : []),
      "This is a chain snapshot, not investment advice or a price feed.",
    ].join("\n");
  }

  async #walletSummary(address: string, observedAtMs: number): Promise<string> {
    const [balance, tokenAccounts, transfers] = await Promise.all([
      this.#rpc.call<Record<string, unknown>>("getBalance", [
        address,
        { commitment: "finalized" },
      ]),
      this.#rpc.call<HeliusTokenAccountsResult>("getTokenAccounts", {
        owner: address,
        page: 1,
        limit: 20,
        options: { showZeroBalance: false },
      }),
      this.#rpc.call<HeliusTransfersResult>("getTransfersByAddress", [
        address,
        { sortOrder: "desc", commitment: "finalized", limit: 10 },
      ]),
    ]);
    const lamports = finiteNumber(balance.value);
    const accounts = parseTokenAccounts(tokenAccounts);
    const transferRows = Array.isArray(transfers.data)
      ? (transfers.data as HeliusTransfer[])
      : [];
    const lines = [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: wallet summary",
      `Wallet: ${address}`,
      `Finalized SOL balance: ${lamports === undefined ? "unknown" : (lamports / 1_000_000_000).toFixed(9)}`,
      `Non-zero token accounts in bounded page: ${accounts.length}`,
      ...(integer(tokenAccounts.last_indexed_slot) !== undefined
        ? [`Token index slot: ${integer(tokenAccounts.last_indexed_slot)}`]
        : []),
    ];
    if (accounts.length > 0) {
      lines.push("Reported token balances (raw units; bounded page):");
      accounts.slice(0, 8).forEach((account) => {
        lines.push(`- ${account.mint ?? "unknown mint"}: ${account.amount} raw units`);
      });
    }
    if (transferRows.length > 0) {
      lines.push("Recent public transfers:");
      for (const transfer of transferRows.slice(0, 8)) {
        const time = integer(transfer.blockTime);
        const type = safeString(transfer.type, 32) ?? "transfer";
        const mint = safeString(transfer.mint, 64) ?? "SOL/unknown";
        const amount =
          safeScalarString(transfer.uiAmount ?? transfer.amount, 64) ??
          "unknown";
        const signature = safeString(transfer.signature, 96);
        lines.push(
          `- ${time === undefined ? "time unknown" : new Date(time * 1_000).toISOString()} | ${type} | ${amount} | ${mint}${signature === undefined ? "" : ` | ${shorten(signature)}`}`,
        );
      }
    }
    lines.push(
      "Only normalized public balances and transfers are included; raw program logs and arbitrary transaction text were not passed to the model.",
    );
    return lines.join("\n");
  }

  async #transactionSummary(
    signature: string,
    observedAtMs: number,
  ): Promise<string> {
    const transaction = await this.#rpc.call<Record<string, unknown> | null>(
      "getTransaction",
      [
        signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    );
    if (transaction === null || !isRecord(transaction)) {
      throw new HeliusRequestError("transaction_not_found");
    }
    const meta = isRecord(transaction.meta) ? transaction.meta : undefined;
    const tx = isRecord(transaction.transaction) ? transaction.transaction : undefined;
    const message = isRecord(tx?.message) ? tx.message : undefined;
    const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
    const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
    const inner = Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : [];
    const tokenChanges = Array.isArray(meta?.postTokenBalances)
      ? meta.postTokenBalances.length
      : 0;
    return [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: transaction summary",
      `Signature: ${signature}`,
      `Slot: ${integer(transaction.slot) ?? "unknown"}`,
      `Block time: ${integer(transaction.blockTime) === undefined ? "unknown" : new Date(integer(transaction.blockTime)! * 1_000).toISOString()}`,
      `Status: ${meta?.err === null ? "succeeded" : meta?.err === undefined ? "unknown" : "failed"}`,
      `Fee lamports: ${integer(meta?.fee) ?? "unknown"}`,
      `Compute units consumed: ${integer(meta?.computeUnitsConsumed) ?? "unknown"}`,
      `Account keys: ${accountKeys.length}`,
      `Top-level instructions: ${instructions.length}`,
      `Inner instruction groups: ${inner.length}`,
      `Post-token balance entries: ${tokenChanges}`,
      "Raw logs, memos, and arbitrary instruction text were deliberately excluded from model context.",
    ].join("\n");
  }

  async #networkSummary(observedAtMs: number): Promise<string> {
    const [health, slot, blockHeight, epoch] = await Promise.all([
      this.#optional<unknown>("getHealth", []),
      this.#rpc.call<number>("getSlot", [{ commitment: "finalized" }]),
      this.#rpc.call<number>("getBlockHeight", [{ commitment: "finalized" }]),
      this.#rpc.call<Record<string, unknown>>("getEpochInfo", [
        { commitment: "finalized" },
      ]),
    ]);
    return [
      "Source: Helius read-only Solana mainnet data",
      `Observed at: ${new Date(observedAtMs).toISOString()}`,
      "Result type: network summary",
      `Health: ${safeString(health, 32) ?? "unknown"}`,
      `Finalized slot: ${integer(slot) ?? "unknown"}`,
      `Finalized block height: ${integer(blockHeight) ?? "unknown"}`,
      `Epoch: ${integer(epoch.epoch) ?? "unknown"}`,
      `Slot index in epoch: ${integer(epoch.slotIndex) ?? "unknown"}`,
      `Slots in epoch: ${integer(epoch.slotsInEpoch) ?? "unknown"}`,
    ].join("\n");
  }
}
