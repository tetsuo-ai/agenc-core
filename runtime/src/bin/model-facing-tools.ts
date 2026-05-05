import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { isIP } from "node:net";
import {
  ROOT_AGENT_PATH,
  type AgentPath,
  type ThreadId,
} from "../agents/registry.js";
import type { Session } from "../session/session.js";
import {
  createProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
  type ProviderFactoryOptions,
} from "../llm/provider.js";
import {
  PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  supportsProviderNativeWebSearch,
} from "../llm/provider-native-search.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMWebSearchConfig,
} from "../llm/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import { createFileReadTool } from "../tools/system/file-read.js";
import { createFileWriteTool } from "../tools/system/file-write.js";
import {
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
  safePathAllowingSessionPlanFile,
} from "../tools/system/filesystem.js";
import { SESSION_ID_ARG } from "../agents/_deps/filesystem-args.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/index.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "../tools/system/exec-result-format.js";
import {
  CodeIntelManager,
  toRelativeWorkspacePath,
} from "../tools/system/code-intel.js";
import { delegate } from "../agents/delegate.js";
import {
  AgentJobCapacityError,
  runAgentsOnCsv,
  recordAgentJobResult,
  type AgentJobProgressEmitter,
  type AgentJobSpawn,
  type AgentJobSpawnContext,
} from "../agents/jobs/job-orchestrator.js";
import { CsvAgentJobsRepository } from "../state/csv-agent-jobs.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import { ensureAgentControl } from "./delegate-tool.js";
import { createMultiAgentV2Tools } from "../agents/v2/index.js";
import { createTaskTools } from "../tools/tasks/index.js";
import { createStructuredOutputTool } from "./structured-output-tool.js";
import { isPreapprovedHost } from "./web-fetch-preapproved.js";
import { createRequestUserInputTool } from "../elicitation/request-user-input.js";
import { getRuleByContentsForTool } from "../permissions/rules.js";
import type {
  PermissionResult,
  PermissionRuleValue,
  PermissionUpdate,
  ToolPermissionContext,
} from "../permissions/types.js";
import type { ToolEvaluatorContext } from "../permissions/evaluator.js";
import { peekLSPDiagnosticsForFile } from "../services/lsp/LSPDiagnosticRegistry.js";
import {
  getInitializationStatus,
  getLspServerManager,
  waitForInitialization,
} from "../services/lsp/manager.js";

export interface ModelFacingToolOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly getSession: () => Session | null;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  readonly emitWarning?: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerFactory?: typeof createProvider;
}

interface StoredCron {
  readonly id: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly timezone?: string;
  readonly durable: boolean;
  readonly createdAt: string;
}

interface ToolState {
  readonly crons: readonly StoredCron[];
}

interface WebSearchFilters {
  readonly allowedDomains: readonly string[];
  readonly blockedDomains: readonly string[];
}

interface WebSearchResultEntry {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FETCH_CHARS = 120_000;
const MAX_FETCH_BYTES = 512_000;
const MIN_FETCH_BYTES = 16_384;
const MAX_FETCH_REDIRECTS = 5;
const MAX_SEARCH_RESULTS = 8;
const WEB_FETCH_TOOL_NAME = "web_fetch";
const LEGACY_WEB_FETCH_TOOL_NAME = "WebFetch";
const WEB_FETCH_TOOL_NAMES = [
  WEB_FETCH_TOOL_NAME,
  LEGACY_WEB_FETCH_TOOL_NAME,
] as const;

function json(content: unknown, isError?: boolean): ToolResult {
  return { content: safeStringify(content), ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolMetadata(
  family: string,
  opts: {
    readonly mutating?: boolean;
    readonly deferred?: boolean;
    readonly hiddenByDefault?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family,
    source: "builtin",
    hiddenByDefault: opts.hiddenByDefault ?? false,
    mutating: opts.mutating ?? false,
    deferred: opts.deferred ?? false,
    keywords: opts.keywords ?? [family],
    preferredProfiles: ["coding", "operator", "general"],
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizedStringArray(value: unknown): readonly string[] {
  return stringArray(value)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stateRoot(opts: ModelFacingToolOptions): string {
  return opts.agencHome ?? join(homedir(), ".agenc");
}

function stateFile(opts: ModelFacingToolOptions): string {
  return join(stateRoot(opts), "runtime-tools", "state.json");
}

async function readState(opts: ModelFacingToolOptions): Promise<ToolState> {
  try {
    const raw = await readFile(stateFile(opts), "utf8");
    const parsed = JSON.parse(raw) as Partial<ToolState>;
    return {
      crons: Array.isArray(parsed.crons) ? parsed.crons : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { crons: [] };
    }
    throw error;
  }
}

async function writeState(opts: ModelFacingToolOptions, state: ToolState): Promise<void> {
  const file = stateFile(opts);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function resolveWorkspacePath(opts: ModelFacingToolOptions, input: string): string {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(opts.workspaceRoot, input);
  const root = resolve(opts.workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`path is outside the workspace: ${input}`);
  }
  return resolved;
}

// Turndown drags in an HTML parser; lazy-load via dynamic import so the
// cost is only paid when an HTML response is actually fetched.
// Mirrors the lazy pattern in `utils/lockfile.ts`.
type TurndownInstance = {
  turndown: (html: string) => string;
  remove: (filter: string | string[]) => unknown;
};
let cachedTurndown: TurndownInstance | undefined;

async function getTurndown(): Promise<TurndownInstance> {
  if (cachedTurndown) return cachedTurndown;
  const mod = (await import("turndown")) as unknown as {
    default: new (opts?: Record<string, unknown>) => TurndownInstance;
  };
  const service = new mod.default({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  service.remove(["script", "style", "noscript"]);
  cachedTurndown = service;
  return service;
}

async function htmlToMarkdown(html: string): Promise<string> {
  const service = await getTurndown();
  return service.turndown(html).trim();
}

function htmlToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  opts: { readonly validateWebFetchUrls?: boolean } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (opts.validateWebFetchUrls !== true) {
      return await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "agenc-runtime/0.2",
          accept: "text/html,text/plain,application/json,*/*",
        },
      });
    }

    let currentUrl = validateWebFetchFinalUrl(url);
    let redirects = 0;
    while (true) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": "agenc-runtime/0.2",
          accept: "text/html,text/plain,application/json,*/*",
        },
      });
      if (!isRedirectStatus(response.status)) {
        validateWebFetchFinalUrl(response.url || currentUrl);
        return response;
      }

      if (redirects >= MAX_FETCH_REDIRECTS) {
        throw new Error(`too many redirects; limit is ${MAX_FETCH_REDIRECTS}`);
      }
      const location = response.headers.get("location");
      if (!location) {
        validateWebFetchFinalUrl(response.url || currentUrl);
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = normalizeWebFetchRedirectUrl(currentUrl, location);
      redirects += 1;
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface BoundedResponseText {
  readonly text: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<BoundedResponseText> {
  const byteLimit = Math.max(1, Math.floor(maxBytes));
  const contentLength = parseContentLength(response.headers.get("content-length"));
  const reader = response.body?.getReader();
  if (!reader) {
    if (contentLength !== undefined && contentLength > byteLimit) {
      throw new Error(`response body exceeds ${byteLimit} byte fetch limit`);
    }
    const text = await response.text();
    return { text, bytesRead: new TextEncoder().encode(text).byteLength, truncated: false };
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = byteLimit - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      const chunk =
        value.byteLength > remaining ? value.slice(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    text += decoder.decode();
    return { text, bytesRead, truncated };
  } finally {
    reader.releaseLock();
  }
}

function normalizeDomainFilter(raw: string): string | undefined {
  const value = raw.trim().toLowerCase().replace(/^\*\./, "");
  if (value.length === 0) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.replace(/^\*\./, "");
  } catch {
    return value.split("/")[0]?.replace(/^\*\./, "");
  }
}

function webSearchFilters(args: Record<string, unknown>): WebSearchFilters {
  const allowedDomains = normalizedStringArray(args.allowed_domains)
    .map(normalizeDomainFilter)
    .filter((domain): domain is string => domain !== undefined);
  const blockedDomains = normalizedStringArray(args.blocked_domains)
    .map(normalizeDomainFilter)
    .filter((domain): domain is string => domain !== undefined);
  return { allowedDomains, blockedDomains };
}

function webSearchConfigFromFilters(
  filters: WebSearchFilters,
): LLMWebSearchConfig | undefined {
  if (
    filters.allowedDomains.length === 0 &&
    filters.blockedDomains.length === 0
  ) {
    return undefined;
  }
  return {
    ...(filters.allowedDomains.length > 0
      ? { allowedDomains: filters.allowedDomains }
      : {}),
    ...(filters.blockedDomains.length > 0
      ? { excludedDomains: filters.blockedDomains }
      : {}),
  };
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function urlMatchesAnyDomain(
  rawUrl: string,
  domains: readonly string[],
): boolean {
  if (domains.length === 0) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return domains.some((domain) => hostnameMatchesDomain(hostname, domain));
  } catch {
    return false;
  }
}

function isUsableWebSearchUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function filterWebSearchResults(
  results: readonly WebSearchResultEntry[],
  filters: WebSearchFilters,
): readonly WebSearchResultEntry[] {
  return results.filter((entry) => {
    if (
      filters.allowedDomains.length > 0 &&
      !urlMatchesAnyDomain(entry.url, filters.allowedDomains)
    ) {
      return false;
    }
    if (urlMatchesAnyDomain(entry.url, filters.blockedDomains)) {
      return false;
    }
    return true;
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function webSearchResultFromSource(value: unknown): WebSearchResultEntry | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const url =
    stringValue(record.url) ??
    stringValue(record.uri) ??
    stringValue(record.link);
  if (!url || !isUsableWebSearchUrl(url)) return undefined;
  return {
    title:
      stringValue(record.title) ??
      stringValue(record.name) ??
      url,
    url,
    snippet:
      stringValue(record.snippet) ??
      stringValue(record.text) ??
      stringValue(record.summary) ??
      stringValue(record.description) ??
      "",
  };
}

function addWebSearchResult(
  results: Map<string, WebSearchResultEntry>,
  entry: WebSearchResultEntry,
): void {
  const existing = results.get(entry.url);
  if (!existing) {
    results.set(entry.url, entry);
    return;
  }
  if (existing.title === existing.url && entry.title !== entry.url) {
    results.set(entry.url, entry);
  }
}

function extractSourceResultsFromRaw(
  raw: Record<string, unknown> | undefined,
): readonly WebSearchResultEntry[] {
  if (!raw) return [];
  const sourceCandidates: unknown[] = [
    ...arrayValue(raw.sources),
    ...arrayValue(recordValue(raw.action)?.sources),
    ...arrayValue(recordValue(raw.result)?.sources),
  ];
  for (const result of arrayValue(raw.results)) {
    sourceCandidates.push(result);
    sourceCandidates.push(...arrayValue(recordValue(result)?.sources));
  }
  return sourceCandidates
    .map(webSearchResultFromSource)
    .filter((entry): entry is WebSearchResultEntry => entry !== undefined);
}

function extractGrokNativeSourceResults(
  response: LLMResponse,
): readonly WebSearchResultEntry[] {
  const results = new Map<string, WebSearchResultEntry>();
  for (const call of response.providerEvidence?.serverSideToolCalls ?? []) {
    if (call.toolType !== PROVIDER_NATIVE_WEB_SEARCH_TOOL) continue;
    for (const entry of extractSourceResultsFromRaw(call.raw)) {
      addWebSearchResult(results, entry);
    }
  }
  for (const citation of response.providerEvidence?.citations ?? []) {
    if (!isUsableWebSearchUrl(citation)) continue;
    addWebSearchResult(results, {
      title: citation,
      url: citation,
      snippet: "",
    });
  }
  return [...results.values()];
}

function currentSessionProvider(
  opts: ModelFacingToolOptions,
): LLMProvider | undefined {
  const session = opts.getSession();
  return (session?.services as { provider?: LLMProvider } | undefined)
    ?.provider;
}

function buildGrokNativeWebSearchProvider(
  opts: ModelFacingToolOptions,
  filters: WebSearchFilters,
): LLMProvider | undefined {
  const currentProvider = currentSessionProvider(opts);
  if (readProviderIdentity(currentProvider) !== "grok" || !currentProvider) {
    return undefined;
  }
  const factoryOptions = readProviderFactoryOptions(currentProvider);
  if (
    !supportsProviderNativeWebSearch({
      provider: "grok",
      model: factoryOptions.model,
      webSearch: true,
      searchMode: "on",
    })
  ) {
    return undefined;
  }
  const webSearchOptions = webSearchConfigFromFilters(filters);
  const extra: ProviderFactoryOptions["extra"] = {
    ...(factoryOptions.extra ?? {}),
    webSearch: true,
    searchMode: "on",
    ...(webSearchOptions !== undefined
      ? { webSearchOptions }
      : {}),
  };
  const providerFactory = opts.providerFactory ?? createProvider;
  try {
    return providerFactory("grok", {
      ...factoryOptions,
      tools: [],
      extra,
    });
  } catch {
    return undefined;
  }
}

function abortSignalFromArgs(
  args: Record<string, unknown>,
): AbortSignal | undefined {
  const signal = (args as { readonly __abortSignal?: unknown }).__abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function hasGrokNativeWebSearchToolUse(response: LLMResponse): boolean {
  if ((response.usage.webSearchRequests ?? 0) > 0) return true;
  const evidence = response.providerEvidence;
  if (
    evidence?.serverSideToolCalls?.some(
      (call) =>
        call.toolType === PROVIDER_NATIVE_WEB_SEARCH_TOOL ||
        call.type === "web_search_call",
    ) === true
  ) {
    return true;
  }
  if (
    evidence?.serverSideToolUsage?.some(
      (entry) =>
        entry.toolType === PROVIDER_NATIVE_WEB_SEARCH_TOOL && entry.count > 0,
    ) === true
  ) {
    return true;
  }
  return false;
}

async function runGrokNativeWebSearch(
  opts: ModelFacingToolOptions,
  args: Record<string, unknown>,
  query: string,
  maxResults: number,
  filters: WebSearchFilters,
): Promise<ToolResult | undefined> {
  const provider = buildGrokNativeWebSearchProvider(opts, filters);
  if (!provider) return undefined;
  try {
    const response = await provider.chat(
      [
        {
          role: "user",
          content:
            `Search the web for this query and return concise findings with source URLs.\n\nQuery: ${query}`,
        },
      ],
      {
        systemPrompt:
          "You are AgenC's web search tool. Use the provider-native web search tool and cite source URLs.",
        maxOutputTokens: 1_200,
        tools: [],
        toolRouting: {
          allowedToolNames: [PROVIDER_NATIVE_WEB_SEARCH_TOOL],
        },
        signal: abortSignalFromArgs(args),
      },
    );
    if (
      response.finishReason === "error" ||
      !hasGrokNativeWebSearchToolUse(response)
    ) {
      return undefined;
    }
    const sourceResults = extractGrokNativeSourceResults(response);
    const results = filterWebSearchResults(sourceResults, filters).slice(
      0,
      maxResults,
    );
    if (results.length === 0) {
      return undefined;
    }
    const citations = results.map((entry) => entry.url);
    return json({
      query,
      source: "grok_web_search",
      provider: "grok",
      results,
      answer: response.content.trim(),
      citations,
      web_search_requests: response.usage.webSearchRequests ?? 0,
    });
  } catch {
    return undefined;
  }
}

function normalizeUrl(raw: string): string {
  return validateWebFetchUrl(raw, { upgradeHttp: true });
}

function validateWebFetchFinalUrl(raw: string): string {
  return validateWebFetchUrl(raw, { upgradeHttp: false });
}

function normalizeWebFetchRedirectUrl(currentUrl: string, location: string): string {
  const current = new URL(currentUrl);
  const next = new URL(location, currentUrl);
  const validated = validateWebFetchFinalUrl(next.toString());
  const validatedNext = new URL(validated);
  if (validatedNext.hostname !== current.hostname) {
    throw new Error(
      `redirect target changes host from ${current.hostname} to ${validatedNext.hostname}`,
    );
  }
  return validated;
}

function validateWebFetchUrl(
  raw: string,
  opts: { readonly upgradeHttp: boolean },
): string {
  const input = opts.upgradeHttp && raw.slice(0, "http://".length).toLowerCase() === "http://"
    ? `https://${raw.slice("http://".length)}`
    : raw;
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("URL must use https");
  }
  if (url.username || url.password) {
    throw new Error("URL must not include embedded credentials");
  }
  if (isBlockedWebFetchHostname(url.hostname)) {
    throw new Error("URL targets a private, loopback, or link-local address");
  }
  return url.toString();
}

function isBlockedWebFetchHostname(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const ipVersion = isIP(unwrapped);
  if (ipVersion === 4) return isBlockedWebFetchIPv4(unwrapped);
  if (ipVersion === 6) return isBlockedWebFetchIPv6(unwrapped);
  return false;
}

function isBlockedWebFetchIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    parts.some((part) => Number.isNaN(part))
  ) {
    return false;
  }
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedWebFetchIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;

  const mappedV4 = webFetchMappedIPv4(lower);
  if (mappedV4 !== null) return isBlockedWebFetchIPv4(mappedV4);

  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  const firstHextet = lower.split(":")[0];
  return (
    firstHextet !== undefined &&
    firstHextet.length === 4 &&
    firstHextet >= "fe80" &&
    firstHextet <= "febf"
  );
}

function expandWebFetchIPv6Groups(address: string): number[] | null {
  let addr = address;
  let tailHextets: number[] = [];
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    const v4 = addr.slice(lastColon + 1);
    addr = addr.slice(0, lastColon);
    const octets = v4.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    tailHextets = [
      (octets[0]! << 8) | octets[1]!,
      (octets[2]! << 8) | octets[3]!,
    ];
  }

  const dbl = addr.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dbl === -1) {
    head = addr.split(":");
    tail = [];
  } else {
    const headStr = addr.slice(0, dbl);
    const tailStr = addr.slice(dbl + 2);
    head = headStr === "" ? [] : headStr.split(":");
    tail = tailStr === "" ? [] : tailStr.split(":");
  }

  const target = 8 - tailHextets.length;
  const fill = target - head.length - tail.length;
  if (fill < 0) return null;

  const groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  const nums = groups.map((group) => parseInt(group, 16));
  if (nums.some((num) => Number.isNaN(num) || num < 0 || num > 0xffff)) {
    return null;
  }
  nums.push(...tailHextets);
  return nums.length === 8 ? nums : null;
}

function webFetchMappedIPv4(address: string): string | null {
  const groups = expandWebFetchIPv6Groups(address);
  if (!groups) return null;
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

function strictArgs(
  args: Record<string, unknown>,
  opts: {
    readonly allowed: ReadonlySet<string>;
    readonly required?: ReadonlyArray<string>;
  },
): ToolResult | null {
  const allowed = new Set<string>([
    ...opts.allowed,
    "__callId",
    SESSION_ID_ARG,
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return json({ error: `unknown field \`${key}\`` }, true);
    }
  }
  for (const key of opts.required ?? []) {
    const value = args[key];
    if (typeof value !== "string") {
      return json({ error: `${key} is required` }, true);
    }
  }
  return null;
}

function callIdFromArgs(
  args: Record<string, unknown>,
  prefix: string,
): string {
  return stringValue(args.__callId) ?? `${prefix}-${randomUUID()}`;
}

const csvAgentJobsRepoCache: Map<string, CsvAgentJobsRepository> = new Map();

function getCsvAgentJobsRepository(
  workspaceRoot: string,
): CsvAgentJobsRepository {
  const cached = csvAgentJobsRepoCache.get(workspaceRoot);
  if (cached) return cached;
  const driver = openStateDatabases({ cwd: workspaceRoot });
  const repo = new CsvAgentJobsRepository(driver);
  csvAgentJobsRepoCache.set(workspaceRoot, repo);
  return repo;
}

function currentAgentContext(session: Session, args: Record<string, unknown>): {
  readonly threadId: ThreadId;
  readonly agentPath: AgentPath;
  readonly agentNickname?: string;
  readonly agentRole?: string;
} {
  const { control } = ensureAgentControl(session);
  const injectedSessionId = stringValue(args[SESSION_ID_ARG]);
  if (injectedSessionId) {
    const live = control.getLive(injectedSessionId);
    if (live) {
      return {
        threadId: live.agentId,
        agentPath: live.agentPath,
        agentNickname: live.nickname,
        agentRole: live.role.name,
      };
    }
  }
  return {
    threadId: session.conversationId,
    agentPath: ROOT_AGENT_PATH,
  };
}

function getSessionOrError(opts: ModelFacingToolOptions): Session | ToolResult {
  const session = opts.getSession();
  if (session === null) {
    return json({ error: "tool invoked before session was initialized" }, true);
  }
  return session;
}

function createAgentTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const emit = (session: Session, msg: Parameters<Session["emit"]>[0]["msg"]): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg,
    });
  };

  const multiAgentV2Tools = createMultiAgentV2Tools({
    getSession: opts.getSession,
    ensureAgentControl,
  });

  const spawnAgentsOnCsv = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set([
        "csv_path",
        "instruction",
        "id_column",
        "output_csv_path",
        "max_concurrency",
        "max_workers",
        "max_runtime_seconds",
        "output_schema",
      ]),
      required: ["csv_path", "instruction"],
    });
    if (strict) return strict;
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const session = sessionOrError;
    const agentMaxThreads =
      session.config?.agent_max_threads ??
      session.config?.multiAgentV2?.maxConcurrentThreadsPerSession;
    if (agentMaxThreads === 0) {
      // Mirrors agenc `spawn_agents_on_csv` early reject at
      // agent_jobs.rs:537 when the session forbids any concurrent
      // worker threads.
      return json(
        { error: "agent_max_threads is 0; spawn_agents_on_csv is disabled" },
        true,
      );
    }
    const { control, registry } = ensureAgentControl(session);
    const current = currentAgentContext(session, args);
    const instruction = stringValue(args.instruction);
    if (!instruction || instruction.trim().length === 0) {
      return json({ error: "instruction must be non-empty" }, true);
    }
    const csvPath = stringValue(args.csv_path)!;
    const idColumn = stringValue(args.id_column);
    const outputCsvPath = stringValue(args.output_csv_path);
    const maxConcurrency =
      numberValue(args.max_concurrency) ?? numberValue(args.max_workers);
    const maxRuntimeSeconds = numberValue(args.max_runtime_seconds);
    const outputSchema =
      typeof args.output_schema === "object" &&
      args.output_schema !== null &&
      !Array.isArray(args.output_schema)
        ? (args.output_schema as Record<string, unknown>)
        : undefined;

    const spawn: AgentJobSpawn = {
      async spawn(ctx: AgentJobSpawnContext) {
        const outcome = await delegate({
          parent: session,
          parentPath: current.agentPath,
          control,
          registry,
          taskPrompt: ctx.workerPrompt,
          agentName: ctx.itemId,
          runInBackground: true,
        });
        if (outcome.kind === "rejected") {
          // AgenC's `AgenCErr::AgentLimitReached` arm at
          // agent_jobs.rs:658 surfaces as the AgenC
          // `AgentLimitReachedError` ("agent limit reached (max=N)")
          // re-thrown by `delegate` -> rejected outcome.
          if (outcome.reason.toLowerCase().includes("agent limit reached")) {
            throw new AgentJobCapacityError(outcome.reason);
          }
          throw new Error(
            `agent-jobs spawn rejected for item ${ctx.itemId}: ${outcome.reason}`,
          );
        }
        const thread = outcome.thread;
        // AgenC `agent_jobs.rs:704` subscribes to thread status to detect
        // a worker that terminates without calling `report_agent_job_result`
        // (handled by `finalize_finished_item`). AgenC mirrors this by
        // resolving `threadFinished` when `thread.join()` completes; the
        // orchestrator's finalize guard then converts a still-pending item
        // into a failed one with agenc's exact error message.
        const threadFinished = thread
          .join()
          .then(() => undefined)
          .catch(() => undefined);
        return { threadId: thread.threadId, threadFinished };
      },
      async cancelOutstanding() {
        // In-memory orchestrator: workers self-terminate when they
        // observe a stop=true report. Outstanding agents will be
        // bounded by `max_runtime_seconds`. Hard-cancel via the
        // control plane is deferred (agenc SQLite-backed lifecycle
        // not ported).
      },
    };

    const repository = getCsvAgentJobsRepository(opts.workspaceRoot);
    const callId = callIdFromArgs(args, "agent_job");
    // Mirror agenc `notify_background_event(turn, "agent_job_progress:{json}")`
    // (agent_jobs.rs:172-174) by emitting a `tool_progress` event whose
    // chunk is the agenc line verbatim. Operators wired to the AgenC
    // event bus see the same payload agenc prints.
    const progressEmitter: AgentJobProgressEmitter = (update) => {
      const payload = {
        job_id: update.jobId,
        total_items: update.totalItems,
        pending_items: update.pendingItems,
        running_items: update.runningItems,
        completed_items: update.completedItems,
        failed_items: update.failedItems,
        ...(update.etaSeconds !== undefined
          ? { eta_seconds: update.etaSeconds }
          : {}),
      };
      emit(session, {
        type: "tool_progress",
        payload: {
          callId,
          toolName: "spawn_agents_on_csv",
          chunk: `agent_job_progress:${JSON.stringify(payload)}`,
          stream: "status",
          at: Date.now(),
        },
      });
    };

    try {
      const result = await runAgentsOnCsv({
        csvPath,
        instruction,
        ...(idColumn !== undefined ? { idColumn } : {}),
        ...(outputCsvPath !== undefined ? { outputCsvPath } : {}),
        ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        ...(maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds } : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(agentMaxThreads !== undefined ? { agentMaxThreads } : {}),
        spawn,
        repository,
        progressEmitter,
      });
      return json({
        job_id: result.jobId,
        items: result.items.map((item) => ({
          item_id: item.itemId,
          status: item.status,
          ...(item.error !== undefined ? { error: item.error } : {}),
          ...(item.result !== undefined ? { result: item.result } : {}),
        })),
        stopped_early: result.stoppedEarly,
        ...(result.outputCsvPath !== undefined
          ? { output_csv_path: result.outputCsvPath }
          : {}),
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  };

  const reportAgentJobResultHandler = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["job_id", "item_id", "result", "stop"]),
      required: ["job_id", "item_id"],
    });
    if (strict) return strict;
    const jobId = stringValue(args.job_id);
    const itemId = stringValue(args.item_id);
    if (jobId === undefined || itemId === undefined) {
      return json({ error: "job_id and item_id must be strings" }, true);
    }
    const result = args.result;
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      return json({ error: "result must be a JSON object" }, true);
    }
    const stop = args.stop;
    if (stop !== undefined && typeof stop !== "boolean") {
      return json({ error: "stop must be a boolean" }, true);
    }
    const outcome = recordAgentJobResult({
      jobId,
      itemId,
      result: result as Record<string, unknown>,
      ...(stop !== undefined ? { stop } : {}),
    });
    switch (outcome.kind) {
      case "ok":
        return json({ status: "recorded" });
      case "unknown_job":
        return json({ error: `unknown job_id: ${jobId}` }, true);
      case "unknown_item":
        return json({ error: `unknown item_id: ${itemId}` }, true);
      case "already_reported":
        return json({ error: `item ${itemId} already reported` }, true);
      case "schema_violation":
        return json({ error: outcome.reason }, true);
    }
  };

  return [
    ...multiAgentV2Tools,
    {
      name: "spawn_agents_on_csv",
      description:
        "Spawn one subagent per row of a CSV file. Each row is rendered into the instruction template (using `{column_name}` placeholders); the subagents must call `report_agent_job_result` exactly once with their analysis. Optionally writes an output CSV with each row's status and result.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "spawn", "batch", "csv", "job"],
      }),
      requiresApproval: true,
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          csv_path: {
            type: "string",
            description: "Path to the CSV file containing input rows.",
          },
          instruction: {
            type: "string",
            description:
              "Instruction template applied to each row. Use `{column_name}` placeholders to inject values from the row.",
          },
          id_column: {
            type: "string",
            description: "Optional column name to use as the stable item id.",
          },
          output_csv_path: {
            type: "string",
            description: "Optional output CSV path for exported results.",
          },
          max_concurrency: {
            type: "number",
            description:
              "Maximum concurrent workers for this job. Defaults to 16.",
          },
          max_workers: {
            type: "string",
            description: "Alias for max_concurrency. Set to 1 to run sequentially.",
          },
          max_runtime_seconds: {
            type: "number",
            description:
              "Maximum runtime per worker before it is failed. Defaults to 1800 seconds.",
          },
          output_schema: { type: "object" },
        },
        required: ["csv_path", "instruction"],
        additionalProperties: false,
      },
      execute: spawnAgentsOnCsv,
    },
    {
      name: "report_agent_job_result",
      description:
        "Called by a subagent worker to record its analysis result for an agent-jobs item. Set `stop=true` to cancel the rest of the job after this report.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "job", "report", "result"],
      }),
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "Identifier of the job.",
          },
          item_id: {
            type: "string",
            description: "Identifier of the job item.",
          },
          result: { type: "object" },
          stop: {
            type: "boolean",
            description:
              "Optional. When true, cancels the remaining job items after this result is recorded.",
          },
        },
        required: ["job_id", "item_id", "result"],
        additionalProperties: false,
      },
      execute: reportAgentJobResultHandler,
    },
  ];
}

function createMcpResourceTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const listTool = (name: string): Tool => ({
      name,
      description: "List available resources from configured MCP servers.",
      metadata: toolMetadata("mcp", {
        deferred: true,
        keywords: ["mcp", "resource", "list"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const sessionOrError = getSessionOrError(opts);
        if (!("conversationId" in sessionOrError)) return sessionOrError;
        const server = stringValue(args.server);
        const resources =
          server !== undefined
            ? await sessionOrError.services.mcpManager.getResourcesByServer?.(server)
            : await sessionOrError.services.mcpManager.getResources?.();
        if (resources === undefined) {
          return json({ error: "MCP resource listing is not available" }, true);
        }
        return json({ resources });
      },
    });
  const readTool = (name: string): Tool => ({
      name,
      description: "Read a specific MCP resource by server and URI.",
      metadata: toolMetadata("mcp", {
        deferred: true,
        keywords: ["mcp", "resource", "read"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          uri: { type: "string" },
          resource: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const sessionOrError = getSessionOrError(opts);
        if (!("conversationId" in sessionOrError)) return sessionOrError;
        const server = stringValue(args.server);
        const uri = stringValue(args.uri) ?? stringValue(args.resource);
        if (!server || !uri) {
          return json({ error: "server and uri are required" }, true);
        }
        const resource = await sessionOrError.services.mcpManager.readResource?.(
          `mcp.${server}.${uri}`,
        );
        if (resource === undefined) {
          return json({ error: "MCP resource reading is not available" }, true);
        }
        if (resource === null) {
          return json({ error: `resource not found: ${server} ${uri}` }, true);
        }
        return json({ resource });
      },
    });
  return [
    listTool("ListMcpResourcesTool"),
    readTool("ReadMcpResourceTool"),
    listTool("ListMcpResources"),
    readTool("ReadMcpResource"),
  ];
}

function createSkillTool(opts: ModelFacingToolOptions): Tool {
  return {
    name: "Skill",
    description:
      "Execute a skill within the main conversation. When a skill matches the user's request, call this tool before responding. Pass the skill name and optional arguments; available skills are listed in system reminders.",
    metadata: toolMetadata("skill", {
      keywords: ["skill", "instructions", "capability"],
    }),
    isReadOnly: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        name: { type: "string" },
        args: { type: "string" },
      },
      additionalProperties: false,
    },
    checkPermissions: async (input, context) =>
      checkSkillPermissions(input, context),
    execute: async (args) => {
      const skillName = normalizeSkillName(
        stringValue(args.skill) ?? stringValue(args.name) ?? "",
      );
      if (!skillName) return json({ error: "skill is required" }, true);
      const sessionOrError = getSessionOrError(opts);
      if (!("conversationId" in sessionOrError)) return sessionOrError;
      const rendered =
        (await sessionOrError.services.skillsManager.renderSkill?.({
          name: skillName,
          args: stringValue(args.args),
          sessionId: sessionOrError.conversationId,
        })) ?? null;
      if (!rendered) {
        const outcome = await sessionOrError.services.skillsManager.skillsForConfig(
          {},
          null,
        );
        return json({
          error: `skill not found: ${skillName}`,
          available: outcome.availableSkills?.map((entry) => entry.name) ?? [],
        }, true);
      }

      if (rendered.skill.disableModelInvocation === true) {
        return json({
          error: `skill is not model-invocable: ${rendered.skill.name}`,
        }, true);
      }

      const content = formatLoadedSkillForModel(
        rendered.skill.name,
        rendered.content,
      );
      sessionOrError.services.skillsManager.recordInvokedSkill?.({
        skillName: rendered.skill.name,
        skillPath: rendered.skill.path,
        content: rendered.content,
        invokedAt: Date.now(),
      });
      return { content };
    },
  };
}

function normalizeSkillName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function formatLoadedSkillForModel(skillName: string, content: string): string {
  return `<command-name>${skillName}</command-name>\n${content}`;
}

async function checkSkillPermissions(
  input: unknown,
  context: ToolEvaluatorContext,
) {
  const skillName = normalizeSkillName(
    stringValue((input as { skill?: unknown })?.skill) ??
      stringValue((input as { name?: unknown })?.name) ??
      "",
  );
  if (skillName.length === 0) {
    return {
      behavior: "deny" as const,
      message: "Skill name is required.",
      decisionReason: {
        type: "other" as const,
        reason: "missing skill name",
      },
    };
  }

  const permissionContext = context.getAppState().toolPermissionContext;
  const denyRule = getMatchingSkillContentRule(
    permissionContext,
    "deny",
    skillName,
  );
  if (denyRule !== null) {
    return {
      behavior: "deny" as const,
      message: `Permission to use Skill(${skillName}) has been denied.`,
      decisionReason: { type: "rule" as const, rule: denyRule },
    };
  }

  const allowRule = getMatchingSkillContentRule(
    permissionContext,
    "allow",
    skillName,
  );
  if (allowRule !== null) {
    return {
      behavior: "allow" as const,
      decisionReason: { type: "rule" as const, rule: allowRule },
    };
  }

  const skill =
    (await context.session.services.skillsManager.resolveSkill?.(skillName)) ??
    null;
  if (skill === null) {
    return {
      behavior: "deny" as const,
      message: `Unknown skill: ${skillName}`,
      decisionReason: {
        type: "other" as const,
        reason: "unknown skill",
      },
    };
  }

  if (isSkillAutoAllowable(skill)) {
    return { behavior: "allow" as const };
  }

  return {
    behavior: "ask" as const,
    message: `Allow AgenC to load Skill(${skill.name})?`,
    suggestions: skillPermissionSuggestions(skill.name),
    decisionReason: {
      type: "other" as const,
      reason: "skill requires approval",
    },
  };
}

function getMatchingSkillContentRule(
  permissionContext: ToolPermissionContext,
  behavior: "allow" | "deny",
  skillName: string,
) {
  const rules = getRuleByContentsForTool(permissionContext, "Skill", behavior);
  for (const [content, rule] of rules.entries()) {
    if (content === skillName) return rule;
    if (content.endsWith(":*")) {
      const prefix = content.slice(0, -1);
      if (skillName.startsWith(prefix)) return rule;
    }
  }
  return null;
}

function isSkillAutoAllowable(skill: {
  readonly allowedTools?: readonly string[];
  readonly model?: string;
  readonly hooks?: unknown;
  readonly context?: string;
  readonly agent?: string;
  readonly effort?: string;
  readonly shell?: string;
  readonly disableModelInvocation?: boolean;
}): boolean {
  return (
    (skill.allowedTools?.length ?? 0) === 0 &&
    skill.model === undefined &&
    skill.hooks === undefined &&
    skill.context === undefined &&
    skill.agent === undefined &&
    skill.effort === undefined &&
    skill.shell === undefined &&
    skill.disableModelInvocation !== true
  );
}

function skillPermissionSuggestions(skillName: string): readonly PermissionUpdate[] {
  const rules: PermissionRuleValue[] = [
    { toolName: "Skill", ruleContent: skillName },
  ];
  const colonIndex = skillName.indexOf(":");
  if (colonIndex > 0) {
    rules.push({
      toolName: "Skill",
      ruleContent: `${skillName.slice(0, colonIndex)}:*`,
    });
  }
  return [
    {
      type: "addRules",
      destination: "session",
      rules,
      behavior: "allow",
    },
  ];
}

function webFetchInputToPermissionRuleContent(input: unknown): string {
  const url = stringValue((input as { readonly url?: unknown })?.url);
  if (!url) return "input:missing-url";
  try {
    const parsed = new URL(normalizeUrl(url));
    return `domain:${parsed.hostname}`;
  } catch {
    return `input:${url.slice(0, 100)}`;
  }
}

function getMatchingWebFetchRule(
  permissionContext: ToolPermissionContext,
  behavior: "allow" | "ask" | "deny",
  toolName: string,
  ruleContent: string,
) {
  const names = [
    toolName,
    ...WEB_FETCH_TOOL_NAMES.filter((name) => name !== toolName),
  ];
  for (const candidateName of names) {
    const rule = getRuleByContentsForTool(
      permissionContext,
      candidateName,
      behavior,
    ).get(ruleContent);
    if (rule) return rule;
  }
  return null;
}

function webFetchPermissionSuggestions(
  toolName: string,
  ruleContent: string,
): readonly PermissionUpdate[] {
  return [
    {
      type: "addRules",
      destination: "localSettings",
      rules: [{ toolName, ruleContent }],
      behavior: "allow",
    },
  ];
}

function checkWebFetchPermissions(
  input: unknown,
  context: ToolEvaluatorContext,
  toolName: string,
): PermissionResult {
  const url = stringValue((input as { readonly url?: unknown })?.url);
  if (!url) {
    return {
      behavior: "deny",
      message: `${toolName} requires a url.`,
      decisionReason: { type: "other", reason: "missing url" },
    };
  }

  let normalized: string;
  let parsed: URL;
  try {
    normalized = normalizeUrl(url);
    parsed = new URL(normalized);
  } catch (error) {
    return {
      behavior: "deny",
      message: `${toolName} received an invalid URL: ${errorMessage(error)}`,
      decisionReason: { type: "other", reason: "invalid url" },
    };
  }

  const permissionContext = context.getAppState().toolPermissionContext;
  const ruleContent = webFetchInputToPermissionRuleContent({ url: normalized });
  const denyRule = getMatchingWebFetchRule(
    permissionContext,
    "deny",
    toolName,
    ruleContent,
  );
  if (denyRule !== null) {
    return {
      behavior: "deny",
      message: `${toolName} denied access to ${ruleContent}.`,
      decisionReason: { type: "rule", rule: denyRule },
    };
  }

  const askRule = getMatchingWebFetchRule(
    permissionContext,
    "ask",
    toolName,
    ruleContent,
  );
  if (askRule !== null) {
    return {
      behavior: "ask",
      message: `AgenC requested permission to fetch ${parsed.hostname}.`,
      updatedInput: { ...(input as Record<string, unknown>), url: normalized },
      decisionReason: { type: "rule", rule: askRule },
      suggestions: webFetchPermissionSuggestions(toolName, ruleContent),
    };
  }

  const allowRule = getMatchingWebFetchRule(
    permissionContext,
    "allow",
    toolName,
    ruleContent,
  );
  if (allowRule !== null) {
    return {
      behavior: "allow",
      updatedInput: { ...(input as Record<string, unknown>), url: normalized },
      decisionReason: { type: "rule", rule: allowRule },
    };
  }

  if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
    return {
      behavior: "allow",
      updatedInput: { ...(input as Record<string, unknown>), url: normalized },
      decisionReason: { type: "other", reason: "preapproved host" },
    };
  }

  return {
    behavior: "ask",
    message: `AgenC requested permission to fetch ${parsed.hostname}.`,
    updatedInput: { ...(input as Record<string, unknown>), url: normalized },
    suggestions: webFetchPermissionSuggestions(toolName, ruleContent),
    decisionReason: { type: "other", reason: "web fetch requires approval" },
  };
}

function createWebFetchTool(toolName: string): Tool {
  const isLegacy = toolName === LEGACY_WEB_FETCH_TOOL_NAME;
  return {
    name: toolName,
    description:
      "Fetch an HTTPS URL and return readable text content plus status and final URL.",
    metadata: toolMetadata("web", {
      keywords: ["web", "fetch", "url", "http"],
      deferred: isLegacy,
      hiddenByDefault: isLegacy,
    }),
    isReadOnly: true,
    concurrencyClass: { kind: "shared_read" },
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        prompt: { type: "string" },
        timeout_ms: { type: "number" },
        max_chars: { type: "number" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    checkPermissions: (input, context) =>
      checkWebFetchPermissions(input, context, toolName),
    execute: async (args) => {
      const url = stringValue(args.url);
      if (!url) return json({ error: "url is required" }, true);
      let normalized: string;
      try {
        normalized = normalizeUrl(url);
      } catch (error) {
        return json({ error: errorMessage(error) }, true);
      }
      const maxChars = Math.max(
        1_000,
        Math.min(numberValue(args.max_chars) ?? MAX_FETCH_CHARS, MAX_FETCH_CHARS),
      );
      const maxBytes = Math.max(
        MIN_FETCH_BYTES,
        Math.min(MAX_FETCH_BYTES, maxChars * 4),
      );
      try {
        const response = await fetchWithTimeout(
          normalized,
          numberValue(args.timeout_ms) ?? DEFAULT_TIMEOUT_MS,
          { validateWebFetchUrls: true },
        );
        const finalUrl = validateWebFetchFinalUrl(response.url || normalized);
        const finalParsed = new URL(finalUrl);
        const preapproved = isPreapprovedHost(
          finalParsed.hostname,
          finalParsed.pathname,
        );
        const contentType = response.headers.get("content-type") ?? "";
        const raw = await readResponseTextBounded(response, maxBytes);
        const isHtml = contentType.toLowerCase().includes("html");
        let body: string;
        let renderedAs: "markdown" | "text" | "passthrough";
        if (isHtml) {
          try {
            body = await htmlToMarkdown(raw.text);
            renderedAs = "markdown";
          } catch {
            // Parser failure falls back to a conservative tag strip so a
            // single malformed page does not break the fetch tool entirely.
            body = htmlToText(raw.text);
            renderedAs = "text";
          }
        } else {
          body = raw.text;
          renderedAs = "passthrough";
        }
        let textBody = body;
        if (body.length > maxChars) {
          textBody = `${body.slice(0, maxChars)}\n\n[truncated ${body.length - maxChars} chars]`;
        } else if (raw.truncated) {
          textBody = `${body}\n\n[truncated response after ${raw.bytesRead} bytes]`;
        }
        return json({
          status: response.status,
          ok: response.ok,
          url: normalized,
          final_url: finalUrl,
          content_type: contentType,
          preapproved,
          rendered_as: renderedAs,
          truncated: raw.truncated || body.length > maxChars,
          prompt: stringValue(args.prompt),
          content: textBody,
        }, response.ok ? undefined : true);
      } catch (error) {
        return json({ error: `fetch failed: ${errorMessage(error)}` }, true);
      }
    },
  };
}

function createWebTools(opts: ModelFacingToolOptions): readonly Tool[] {
  return [
    createWebFetchTool(WEB_FETCH_TOOL_NAME),
    createWebFetchTool(LEGACY_WEB_FETCH_TOOL_NAME),
    {
      name: "WebSearch",
      description:
        "Search the web for current information and return result titles, URLs, and snippets.",
      metadata: toolMetadata("web", {
        keywords: ["web", "search", "current", "sources"],
      }),
      isReadOnly: true,
      concurrencyClass: { kind: "shared_read" },
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          allowed_domains: { type: "array", items: { type: "string" } },
          blocked_domains: { type: "array", items: { type: "string" } },
          max_results: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const query = stringValue(args.query);
        if (!query) return json({ error: "query is required" }, true);
        const filters = webSearchFilters(args);
        const endpoint = stringValue(opts.env?.AGENC_WEB_SEARCH_ENDPOINT);
        const maxResults = Math.max(
          1,
          Math.min(numberValue(args.max_results) ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
        );
        const nativeResult = await runGrokNativeWebSearch(
          opts,
          args,
          query,
          maxResults,
          filters,
        );
        if (nativeResult !== undefined) {
          return nativeResult;
        }
        const searchUrl =
          endpoint !== undefined
            ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`
            : `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const response = await fetchWithTimeout(searchUrl);
        const raw = (await response.json()) as Record<string, unknown>;
        const related = Array.isArray(raw.RelatedTopics) ? raw.RelatedTopics : [];
        const results = filterWebSearchResults(related
          .flatMap((entry): Array<Record<string, unknown>> => {
            if (entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).Topics)) {
              return (entry as { Topics: Array<Record<string, unknown>> }).Topics;
            }
            return entry && typeof entry === "object"
              ? [entry as Record<string, unknown>]
              : [];
          })
          .map((entry) => ({
            title: stringValue(entry.Text)?.split(" - ")[0] ?? stringValue(entry.Result) ?? "",
            url: stringValue(entry.FirstURL) ?? "",
            snippet: stringValue(entry.Text) ?? "",
          }))
          .filter((entry) => entry.url.length > 0), filters)
          .slice(0, maxResults);
        return json({
          query,
          source: endpoint !== undefined ? endpoint : "duckduckgo_instant_answer",
          results,
          answer: stringValue(raw.AbstractText),
          heading: stringValue(raw.Heading),
        });
      },
    },
  ];
}

function createNotebookReadTool(opts: ModelFacingToolOptions): Tool {
  const fileReadTool = createFileReadTool({ allowedPaths: [opts.workspaceRoot] });
  const mapNotebookReadInput = (input: unknown): Record<string, unknown> => {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
    return {
      ...record,
      file_path: record.notebook_path,
      cwd: typeof record.cwd === "string" ? record.cwd : opts.workspaceRoot,
    };
  };
  return {
    name: "NotebookRead",
    description:
      "Read Jupyter notebook cells, source, text outputs, errors, and embedded visual outputs from a .ipynb file in the workspace.",
    metadata: toolMetadata("coding", {
      keywords: ["notebook", "ipynb", "read", "jupyter"],
    }),
    isReadOnly: true,
    concurrencyClass: { kind: "shared_read" },
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: {
          type: "string",
          description: "Absolute or workspace-relative path to a .ipynb file.",
        },
        offset: {
          type: "number",
          description: "Optional. Rendered notebook line number to start from (1-indexed).",
        },
        limit: {
          type: "number",
          description: "Optional. Maximum rendered notebook lines to return.",
        },
      },
      required: ["notebook_path"],
      additionalProperties: false,
    },
    async checkPermissions(input, context) {
      const decision = await fileReadTool.checkPermissions?.(
        mapNotebookReadInput(input),
        context,
      );
      if (!decision) {
        return {
          behavior: "passthrough" as const,
          message: "NotebookRead has no path permission hook",
        };
      }
      if (!("updatedInput" in decision) || decision.updatedInput === undefined) {
        return decision;
      }
      const record = input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
      const updatedInput = typeof decision.updatedInput === "object" &&
        !Array.isArray(decision.updatedInput)
        ? (decision.updatedInput as Record<string, unknown>)
        : undefined;
      if (updatedInput === undefined) {
        return decision;
      }
      return {
        ...decision,
        updatedInput: {
          ...record,
          ...updatedInput,
          notebook_path: updatedInput.file_path ?? record.notebook_path,
        },
      } satisfies PermissionResult<Record<string, unknown>>;
    },
    execute: async (args) => {
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) {
        return json({ error: "notebook_path is required" }, true);
      }
      let filePath: string;
      try {
        filePath = resolveWorkspacePath(opts, notebookPath);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
      if (extname(filePath).toLowerCase() !== ".ipynb") {
        return json({ error: "File must be a Jupyter notebook (.ipynb)" }, true);
      }
      return fileReadTool.execute({
        file_path: filePath,
        offset: args.offset,
        limit: args.limit,
        __agencSessionId: args.__agencSessionId,
      });
    },
  };
}

const NOTEBOOK_EDIT_READ_REQUIRED_MESSAGE =
  "File has not been read yet. Read it first before writing to it.";
const NOTEBOOK_EDIT_STALE_READ_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const NOTEBOOK_EDIT_EXTENSION_MESSAGE =
  "File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.";

type NotebookCell = Record<string, unknown>;

interface NotebookDocument extends Record<string, unknown> {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNotebookCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/u.exec(cellId);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function notebookLanguage(notebook: NotebookDocument): string {
  const metadata = isRecord(notebook.metadata) ? notebook.metadata : {};
  const languageInfo = isRecord(metadata.language_info)
    ? metadata.language_info
    : {};
  const name = languageInfo.name;
  return typeof name === "string" && name.length > 0 ? name : "python";
}

function notebookSupportsCellIds(notebook: NotebookDocument): boolean {
  const nbformat = typeof notebook.nbformat === "number" ? notebook.nbformat : 0;
  const minor =
    typeof notebook.nbformat_minor === "number" ? notebook.nbformat_minor : 0;
  return nbformat > 4 || (nbformat === 4 && minor >= 5);
}

function generateNotebookCellId(cells: readonly NotebookCell[]): string {
  const existing = new Set(
    cells
      .map((cell) => cell.id)
      .filter((id): id is string => typeof id === "string"),
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID().replace(/-/gu, "").slice(0, 12);
    if (!existing.has(id)) return id;
  }
  return randomUUID().replace(/-/gu, "");
}

function findNotebookCellIndex(
  cells: readonly NotebookCell[],
  cellId: string,
): { index: number } | { error: string } {
  const exactIndex = cells.findIndex((cell) => cell.id === cellId);
  if (exactIndex !== -1) return { index: exactIndex };

  const parsedCellIndex = parseNotebookCellId(cellId);
  if (parsedCellIndex !== undefined) {
    if (cells[parsedCellIndex] === undefined) {
      return {
        error: `Cell with index ${parsedCellIndex} does not exist in notebook.`,
      };
    }
    return { index: parsedCellIndex };
  }

  return { error: `Cell with ID "${cellId}" not found in notebook.` };
}

function readSessionId(args: Record<string, unknown>): string | undefined {
  const value = args[SESSION_ID_ARG];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function createNotebookEditTool(opts: ModelFacingToolOptions): Tool {
  const fileWriteTool = createFileWriteTool({ allowedPaths: [opts.workspaceRoot] });
  const mapNotebookEditInput = (input: unknown): Record<string, unknown> => {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
    return {
      ...record,
      file_path: record.notebook_path,
      cwd: typeof record.cwd === "string" ? record.cwd : opts.workspaceRoot,
    };
  };
  return {
    name: "NotebookEdit",
    description:
      "Edit Jupyter notebook cells by cell id or insertion point. Requires a .ipynb file in the workspace.",
    metadata: toolMetadata("coding", {
      mutating: true,
      deferred: true,
      keywords: ["notebook", "ipynb", "edit"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: { type: "string" },
        cell_id: { type: "string" },
        new_source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
      },
      required: ["notebook_path", "new_source"],
      additionalProperties: false,
    },
    async checkPermissions(input, context) {
      const decision = await fileWriteTool.checkPermissions?.(
        mapNotebookEditInput(input),
        context,
      );
      if (!decision) {
        return {
          behavior: "passthrough" as const,
          message: "NotebookEdit has no path permission hook",
        };
      }
      if (!("updatedInput" in decision) || decision.updatedInput === undefined) {
        return decision;
      }
      const record = input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
      const updatedInput = typeof decision.updatedInput === "object" &&
        !Array.isArray(decision.updatedInput)
        ? (decision.updatedInput as Record<string, unknown>)
        : undefined;
      if (updatedInput === undefined) {
        return decision;
      }
      return {
        ...decision,
        updatedInput: {
          ...record,
          ...updatedInput,
          notebook_path: updatedInput.file_path ?? record.notebook_path,
        },
      } satisfies PermissionResult<Record<string, unknown>>;
    },
    execute: async (args) => {
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) return json({ error: "notebook_path is required" }, true);
      const editMode = stringValue(args.edit_mode) ?? "replace";
      if (
        editMode !== "replace" &&
        editMode !== "insert" &&
        editMode !== "delete"
      ) {
        return json({ error: "Edit mode must be replace, insert, or delete." }, true);
      }
      if (typeof args.new_source !== "string") {
        return json({ error: "new_source must be a string" }, true);
      }
      const newSource = args.new_source;
      const cellType = stringValue(args.cell_type);
      if (
        cellType !== undefined &&
        cellType !== "code" &&
        cellType !== "markdown"
      ) {
        return json({ error: "Cell type must be code or markdown." }, true);
      }
      if (editMode === "insert" && cellType === undefined) {
        return json({ error: "Cell type is required when using edit_mode=insert." }, true);
      }
      const cellId = stringValue(args.cell_id);
      if (editMode !== "insert" && cellId === undefined) {
        return json({
          error: "Cell ID must be specified when not inserting a new cell.",
        }, true);
      }

      let requestedPath: string;
      try {
        requestedPath = resolveWorkspacePath(opts, notebookPath);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
      if (extname(requestedPath).toLowerCase() !== ".ipynb") {
        return json({ error: NOTEBOOK_EDIT_EXTENSION_MESSAGE }, true);
      }
      const safePath = await safePathAllowingSessionPlanFile(
        requestedPath,
        [opts.workspaceRoot],
        { ...args, file_path: requestedPath, cwd: opts.workspaceRoot },
      );
      if (!safePath.safe) {
        return json({ error: `Access denied: ${safePath.reason}` }, true);
      }
      const filePath = safePath.resolved;

      try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
          return json({ error: "Path is not a regular file" }, true);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return json({ error: "Notebook file does not exist." }, true);
        }
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }

      const sessionId = readSessionId(args);
      if (sessionId !== undefined && !hasSessionRead(sessionId, filePath)) {
        return json({ error: NOTEBOOK_EDIT_READ_REQUIRED_MESSAGE }, true);
      }

      let original: string;
      try {
        original = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return json({ error: "Notebook file does not exist." }, true);
        }
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }

      if (sessionId !== undefined) {
        const snapshot = getSessionReadSnapshot(sessionId, filePath);
        const snapshotContent =
          typeof snapshot?.rawContent === "string"
            ? snapshot.rawContent
            : snapshot?.content;
        if (
          snapshot?.viewKind !== "full" ||
          typeof snapshotContent !== "string"
        ) {
          return json({ error: NOTEBOOK_EDIT_READ_REQUIRED_MESSAGE }, true);
        }
        if (original !== snapshotContent) {
          return json({ error: NOTEBOOK_EDIT_STALE_READ_MESSAGE }, true);
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(original);
      } catch {
        return json({ error: "Notebook is not valid JSON." }, true);
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.cells)) {
        return json({ error: "Invalid notebook: expected a cells array" }, true);
      }
      const notebook = parsed as NotebookDocument;
      const cells = notebook.cells;

      let index = 0;
      if (cellId !== undefined) {
        const found = findNotebookCellIndex(cells, cellId);
        if ("error" in found) {
          return json({ error: found.error }, true);
        }
        index = editMode === "insert" ? found.index + 1 : found.index;
      }

      let resultCellId: string | undefined = cellId;
      if (editMode === "delete") {
        cells.splice(index, 1);
      } else if (editMode === "insert") {
        const newCell: NotebookCell = {
          cell_type: cellType ?? "code",
          metadata: {},
          source: newSource,
        };
        if (notebookSupportsCellIds(notebook)) {
          resultCellId = generateNotebookCellId(cells);
          newCell.id = resultCellId;
        }
        if ((cellType ?? "code") === "code") {
          newCell.execution_count = null;
          newCell.outputs = [];
        }
        cells.splice(index, 0, newCell);
      } else {
        const cell = cells[index]!;
        const wasCode = cell.cell_type === "code";
        cell.source = newSource;
        if (wasCode) {
          cell.execution_count = null;
          cell.outputs = [];
        }
        if (cellType !== undefined && cellType !== cell.cell_type) {
          cell.cell_type = cellType;
        }
      }

      const updated = JSON.stringify(notebook, null, 1);
      await writeFile(filePath, updated, "utf8");
      if (sessionId !== undefined) {
        let mtimeMs = Date.now();
        try {
          const postWriteStats = await stat(filePath);
          if (Number.isFinite(postWriteStats.mtimeMs)) {
            mtimeMs = postWriteStats.mtimeMs;
          }
        } catch {
          // Best effort: session state still needs the post-write bytes.
        }
        recordSessionRead(sessionId, filePath, {
          content: updated,
          rawContent: updated,
          timestamp: mtimeMs,
          viewKind: "full",
        });
      }
      return json({
        notebook_path: filePath,
        cell_id: resultCellId,
        cell_type: cellType ?? "code",
        language: notebookLanguage(notebook),
        edit_mode: editMode,
        new_source: newSource,
        original_file: original,
        updated_file: updated,
      });
    },
  };
}

function createLspTool(opts: ModelFacingToolOptions): Tool {
  const codeIntel = new CodeIntelManager({
    persistenceRootDir: opts.agencHome ?? opts.workspaceRoot,
  });
  return {
    name: "LSP",
    description:
      "Inspect pending language-server diagnostics and native semantic code-index lookups.",
    metadata: toolMetadata("coding", {
      deferred: true,
      keywords: ["lsp", "diagnostics", "definition", "references", "symbols"],
    }),
    isReadOnly: true,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["diagnostics", "definition", "references", "symbols"],
        },
        file_path: { type: "string" },
        symbol: { type: "string" },
        query: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const operation = stringValue(args.operation);
      if (operation === "diagnostics") {
        const filePath = stringValue(args.file_path);
        if (!filePath) return json({ error: "file_path is required" }, true);
        const resolved = resolveWorkspacePath(opts, filePath);
        const exists = existsSync(resolved);
        const fileStat = exists ? await stat(resolved) : null;
        if (!exists || !fileStat?.isFile()) {
          return json({
            file_path: resolved,
            diagnostics: [{
              severity: "error",
              message: "File not found",
            }],
          });
        }

        await waitForInitialization();
        const status = getInitializationStatus();
        const pendingDiagnostics = peekLSPDiagnosticsForFile(resolved);
        if (status.status === "failed") {
          return json({
            file_path: resolved,
            diagnostics: pendingDiagnostics,
            server: null,
            lsp_status: "failed",
            server_error: { message: status.error.message },
            note:
              pendingDiagnostics.length > 0
                ? "Pending language-server diagnostics were returned, but LSP initialization failed."
                : "LSP initialization failed before diagnostics could be refreshed.",
          });
        }

        const manager = getLspServerManager();
        if (!manager) {
          return json({
            file_path: resolved,
            diagnostics: pendingDiagnostics,
            server: null,
            lsp_status: status.status,
            note:
              pendingDiagnostics.length > 0
                ? "Pending language-server diagnostics were returned."
                : "No language server is configured for this file.",
          });
        }

        let serverName: string | null = null;
        try {
          serverName = (await manager.ensureServerStarted(resolved))?.name ?? null;
        } catch (error) {
          return json({
            file_path: resolved,
            diagnostics: pendingDiagnostics,
            server: null,
            lsp_status: "server_error",
            server_error: { message: errorMessage(error) },
            note:
              pendingDiagnostics.length > 0
                ? "Pending language-server diagnostics were returned, but the server failed to start."
                : "The language server failed to start.",
          });
        }
        return json({
          file_path: resolved,
          diagnostics: pendingDiagnostics,
          server: serverName,
          lsp_status: status.status,
          note:
            pendingDiagnostics.length > 0
              ? "Pending language-server diagnostics were returned."
              : serverName === null
                ? "No language server is configured for this file."
                : "No pending diagnostics were available for this file.",
        });
      }

      const query = stringValue(args.symbol) ?? stringValue(args.query);
      if (!query) return json({ error: "symbol or query is required" }, true);
      const filePath = stringValue(args.file_path);
      if (operation === "definition") {
        const definition = await codeIntel.getDefinition({
          workspaceRoot: opts.workspaceRoot,
          symbolName: query,
          ...(filePath !== undefined
            ? { filePath: resolveWorkspacePath(opts, filePath) }
            : {}),
        });
        return json({
          operation,
          query,
          definition:
            definition == null
              ? null
              : {
                  ...definition,
                  filePath: toRelativeWorkspacePath(
                    opts.workspaceRoot,
                    definition.filePath,
                  ),
                },
        });
      }
      if (operation === "references") {
        const references = await codeIntel.getReferences({
          workspaceRoot: opts.workspaceRoot,
          symbolName: query,
          ...(filePath !== undefined
            ? { filePath: resolveWorkspacePath(opts, filePath) }
            : {}),
          maxResults: 100,
        });
        return json({
          operation,
          query,
          references: references.map((entry) => ({
            ...entry,
            filePath: toRelativeWorkspacePath(opts.workspaceRoot, entry.filePath),
          })),
        });
      }
      if (operation !== "symbols") {
        return json(
          {
            error:
              "operation must be diagnostics, definition, references, or symbols",
          },
          true,
        );
      }
      const symbols = await codeIntel.searchSymbols({
        workspaceRoot: opts.workspaceRoot,
        query,
        maxResults: 100,
      });
      return json({
        operation,
        query,
        symbols: symbols.map((symbol) => ({
          ...symbol,
          filePath: toRelativeWorkspacePath(opts.workspaceRoot, symbol.filePath),
        })),
      });
    },
  };
}

function createPlanAndMessageTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const sendMessage = (name: string): Tool => ({
    name,
    description:
      "Send a concise visible progress message to the user during a long-running task.",
    metadata: toolMetadata("operator", {
      keywords: ["brief", "message", "user", "progress"],
    }),
    isReadOnly: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const message = stringValue(args.message);
      if (!message) return json({ error: "message is required" }, true);
      const session = opts.getSession();
      session?.emit({
        id: session.nextInternalSubId(),
        msg: { type: "agent_message", payload: { message } },
      });
      return json({ sent: true, message });
    },
  });

  return [
    {
      name: "VerifyPlanExecution",
      description:
        "Compare the current approved plan with a progress summary and report likely gaps before continuing.",
      metadata: toolMetadata("planning", {
        keywords: ["plan", "verify", "execution"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: {
          progress: { type: "string" },
          completed: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const session = opts.getSession();
        const planPath = join(stateRoot(opts), "plans", `${session?.conversationId ?? "default"}.md`);
        let plan = "";
        try {
          plan = await readFile(planPath, "utf8");
        } catch {
          plan = "";
        }
        const progress = stringValue(args.progress) ?? "";
        const completed = stringArray(args.completed);
        return json({
          plan_available: plan.length > 0,
          plan_path: planPath,
          plan,
          progress,
          completed,
          reminder:
            "Continue only if the next action matches the approved plan or the user has approved a plan change.",
        });
      },
    },
    sendMessage("Brief"),
    sendMessage("SendUserMessage"),
  ];
}

function validateCron(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

function createCronAndWorkflowTools(opts: ModelFacingToolOptions): readonly Tool[] {
  return [
    {
      name: "CronCreate",
      description:
        "Register a local scheduled prompt definition. The current runtime records the schedule; an external runner can execute registered jobs.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["cron", "schedule", "workflow"],
      }),
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          cron: { type: "string" },
          schedule: { type: "string" },
          prompt: { type: "string" },
          timezone: { type: "string" },
          durable: { type: "boolean" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const schedule = stringValue(args.cron) ?? stringValue(args.schedule);
        const prompt = stringValue(args.prompt);
        if (!schedule || !prompt) {
          return json({ error: "cron/schedule and prompt are required" }, true);
        }
        if (!validateCron(schedule)) {
          return json({ error: "cron expression must have five fields" }, true);
        }
        const state = await readState(opts);
        const cron: StoredCron = {
          id: `cron-${randomUUID()}`,
          schedule,
          prompt,
          ...(stringValue(args.timezone) !== undefined
            ? { timezone: stringValue(args.timezone) }
            : {}),
          durable: boolValue(args.durable) ?? true,
          createdAt: new Date().toISOString(),
        };
        await writeState(opts, { ...state, crons: [...state.crons, cron] });
        return json({ cron });
      },
    },
    {
      name: "CronDelete",
      description: "Delete a local scheduled prompt definition.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["cron", "delete"],
      }),
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = stringValue(args.id);
        if (!id) return json({ error: "id is required" }, true);
        const state = await readState(opts);
        const crons = state.crons.filter((cron) => cron.id !== id);
        await writeState(opts, { ...state, crons });
        return json({ deleted: state.crons.length !== crons.length, id });
      },
    },
    {
      name: "CronList",
      description: "List local scheduled prompt definitions.",
      metadata: toolMetadata("workflow", {
        deferred: true,
        keywords: ["cron", "list"],
      }),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => json({ crons: (await readState(opts)).crons }),
    },
    {
      name: "WorkflowTool",
      description:
        "Run a named local workflow from .agenc/workflows or AGENC_HOME/workflows.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["workflow", "run"],
      }),
      requiresApproval: true,
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: { type: "object" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const name = stringValue(args.name);
        if (!name) return json({ error: "name is required" }, true);
        const candidates = [
          join(opts.workspaceRoot, ".agenc", "workflows", `${name}.json`),
          join(stateRoot(opts), "workflows", `${name}.json`),
        ];
        const workflowPath = candidates.find((candidate) => existsSync(candidate));
        if (!workflowPath) {
          return json({ error: `workflow not found: ${name}`, searched: candidates }, true);
        }
        const workflow = JSON.parse(await readFile(workflowPath, "utf8")) as {
          command?: string;
          description?: string;
        };
        if (!workflow.command) {
          return json({ error: `workflow ${name} has no command` }, true);
        }
        if (!opts.unifiedExecManager) {
          return json({ error: "unified exec manager is not available" }, true);
        }
        const output = await opts.unifiedExecManager.execCommand({
          cmd: workflow.command,
          workdir: opts.workspaceRoot,
        });
        return {
          content: formatUnifiedExecToolContent(output),
          isError: output.exitCode !== null && output.exitCode !== 0 ? true : undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
        };
      },
    },
  ];
}

function findPowerShell(env: NodeJS.ProcessEnv): string | null {
  const pathEntries = (env.PATH ?? "").split(":");
  for (const dir of pathEntries) {
    for (const exe of ["pwsh", "powershell"]) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return exe;
    }
  }
  return process.platform === "win32" ? "powershell" : null;
}

function createPowerShellTool(opts: ModelFacingToolOptions): readonly Tool[] {
  const env = opts.env ?? process.env;
  const shell = findPowerShell(env);
  if (shell === null || opts.unifiedExecManager === undefined) return [];
  return [
    {
      name: "PowerShell",
      description:
        "Run a PowerShell command through AgenC unified exec. Only available when PowerShell is installed.",
      metadata: toolMetadata("terminal", {
        mutating: true,
        deferred: true,
        keywords: ["powershell", "terminal", "shell"],
      }),
      requiresApproval: true,
      concurrencyClass: { kind: "background_terminal" },
      recoveryCategory: "side-effecting",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const command = stringValue(args.command);
        if (!command) return json({ error: "command is required" }, true);
        const output = await opts.unifiedExecManager!.execCommand({
          cmd: command,
          shell,
          workdir: opts.workspaceRoot,
          ...(numberValue(args.timeout_ms) !== undefined
            ? { timeoutMs: numberValue(args.timeout_ms) }
            : {}),
        });
        return {
          content: formatUnifiedExecToolContent(output),
          isError: output.exitCode !== null && output.exitCode !== 0 ? true : undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
        };
      },
    },
  ];
}

function createRemoteTriggerTool(opts: ModelFacingToolOptions): Tool {
  return {
    name: "RemoteTrigger",
    description:
      "Inspect local scheduled prompt definitions. Remote hosted trigger management is not enabled in this runtime.",
    metadata: toolMetadata("workflow", {
      deferred: true,
      keywords: ["remote", "trigger", "schedule"],
    }),
    isReadOnly: true,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get"] },
        trigger_id: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = stringValue(args.action) ?? "list";
      const state = await readState(opts);
      if (action === "get") {
        const id = stringValue(args.trigger_id);
        return json({ trigger: state.crons.find((cron) => cron.id === id) ?? null });
      }
      return json({ triggers: state.crons });
    },
  };
}

export function createModelFacingTools(
  opts: ModelFacingToolOptions,
): readonly Tool[] {
  return [
    ...createAgentTools(opts),
    ...createMcpResourceTools(opts),
    createSkillTool(opts),
    ...createWebTools(opts),
    createNotebookReadTool(opts),
    createNotebookEditTool(opts),
    createLspTool(opts),
    createRequestUserInputTool(opts),
    ...createPlanAndMessageTools(opts),
    ...createTaskTools(opts),
    ...createCronAndWorkflowTools(opts),
    createRemoteTriggerTool(opts),
    ...createPowerShellTool(opts),
    createStructuredOutputTool(),
  ];
}
