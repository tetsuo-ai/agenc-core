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
import {
  assertValidAgentName,
  depthOfAgentPath,
  ROOT_AGENT_PATH,
  resolveAgentPath,
  type AgentPath,
  type ThreadId,
} from "../agents/registry.js";
import {
  canonicalAgentRoleName,
  formatAgentRoleLabel,
} from "../agents/role-presentation.js";
import { requireAgentRole } from "../agents/role.js";
import type { ForkMode } from "../agents/fork-context.js";
import type { AgentThread } from "../agents/thread.js";
import {
  toAgentStatusJson,
  type AgentStatus,
} from "../agents/status.js";
import type { Session } from "../session/session.js";
import type { ReasoningEffort } from "../session/turn-context.js";
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
import {
  backgroundTaskLifecycle,
  registerAgentThreadTask,
  BackgroundTaskError,
} from "../tasks/index.js";
import { ensureAgentControl } from "./delegate-tool.js";
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
const MIN_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;
const MAX_FETCH_CHARS = 120_000;
const MAX_SEARCH_RESULTS = 8;
const DEFAULT_MAX_AGENT_DEPTH = 1;

function json(content: unknown, isError?: boolean): ToolResult {
  return { content: safeStringify(content), ...(isError ? { isError: true } : {}) };
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

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "agenc-runtime/0.2",
        accept: "text/html,text/plain,application/json,*/*",
      },
    });
  } finally {
    clearTimeout(timer);
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
  const input = raw.startsWith("http://")
    ? `https://${raw.slice("http://".length)}`
    : raw;
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("URL must use https");
  }
  return url.toString();
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

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

function callIdFromArgs(
  args: Record<string, unknown>,
  prefix: string,
): string {
  return stringValue(args.__callId) ?? `${prefix}-${randomUUID()}`;
}

const SPAWN_AGENT_INHERITED_MODEL_GUIDANCE =
  "Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.";

function buildSpawnAgentDescription(session: Session | null): string {
  const base = `Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
${SPAWN_AGENT_INHERITED_MODEL_GUIDANCE}
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.`;
  const cfg = session?.config?.multiAgentV2;
  const concurrency =
    cfg?.maxConcurrentThreadsPerSession !== undefined
      ? `\nThis session is configured with \`max_concurrent_threads_per_session = ${cfg.maxConcurrentThreadsPerSession}\` for concurrently open agent threads.`
      : "";
  let result = `${base}${concurrency}`;
  if (cfg?.usageHintEnabled && cfg.usageHintText) {
    result = `${result}\n${cfg.usageHintText}`;
  }
  return result;
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

function hideSpawnAgentMetadata(session: Session): boolean {
  return (
    (
      session.config as {
        multiAgentV2?: { hideSpawnAgentMetadata?: boolean };
      }
    )?.multiAgentV2?.hideSpawnAgentMetadata === true
  );
}

function recordAgentCounter(
  session: Session,
  name: string,
  tags: readonly [string, string][] = [],
): void {
  const telemetry = ((
    session as unknown as {
      sessionTelemetry?: {
        counter?: (
          name: string,
          increment: number,
          tags: readonly [string, string][],
        ) => void;
      };
      services?: {
        sessionTelemetry?: {
          counter?: (
            name: string,
            increment: number,
            tags: readonly [string, string][],
          ) => void;
        };
      };
    }
  ).sessionTelemetry ?? session.services.sessionTelemetry) as
    | {
        counter?: (
          name: string,
          increment: number,
          tags: readonly [string, string][],
        ) => void;
      }
    | undefined;
  try {
    telemetry?.counter?.(name, 1, tags);
  } catch {
    // Telemetry must never affect model-facing tool behavior.
  }
}

function receiverMetadataFor(
  session: Session,
  receiverThreadId: ThreadId,
): {
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
} {
  const { control } = ensureAgentControl(session);
  const live = control.getLive(receiverThreadId);
  const metadata = control.getAgentMetadata(receiverThreadId) ?? live?.metadata;
  const roleName = metadata?.agentRole ?? live?.role.name;
  return {
    ...(metadata?.agentNickname !== undefined
      ? { receiverAgentNickname: metadata.agentNickname }
      : live?.nickname !== undefined
        ? { receiverAgentNickname: live.nickname }
        : {}),
    ...(roleName !== undefined ? { receiverAgentRole: roleName } : {}),
    ...(roleName !== undefined
      ? { receiverAgentRoleDisplayName: formatAgentRoleLabel(roleName) }
      : {}),
  };
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

function resolveAgentId(
  session: Session,
  target: string,
  currentAgentPath: AgentPath,
): ThreadId {
  const { control } = ensureAgentControl(session);
  if (target === session.conversationId) return target;
  if (control.getLive(target)) return target;
  return control.resolveAgentReference({
    currentAgentPath,
    reference: target,
  });
}

function resolveSessionMaxAgentDepth(session: Session): number {
  const candidate = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
      ? value
      : undefined;
  return (
    candidate((session.config as { agent_max_depth?: unknown }).agent_max_depth) ??
    candidate(
      (
        session.sessionConfiguration.originalConfigDoNotUse as
          | { agent_max_depth?: unknown }
          | undefined
      )?.agent_max_depth,
    ) ??
    DEFAULT_MAX_AGENT_DEPTH
  );
}

function currentAgentDepth(session: Session, current: { readonly threadId: ThreadId; readonly agentPath: AgentPath }): number {
  const { control } = ensureAgentControl(session);
  return control.getLive(current.threadId)?.depth ?? depthOfAgentPath(current.agentPath);
}

function toListedAgentJson(agent: {
  readonly agentName: string;
  readonly agentStatus: AgentStatus;
  readonly lastTaskMessage?: string;
}): {
  readonly agent_name: string;
  readonly agent_status: ReturnType<typeof toAgentStatusJson>;
  readonly last_task_message?: string;
} {
  return {
    agent_name: agent.agentName,
    agent_status: toAgentStatusJson(agent.agentStatus),
    ...(agent.lastTaskMessage !== undefined
      ? { last_task_message: agent.lastTaskMessage }
      : {}),
  };
}

function getSessionOrError(opts: ModelFacingToolOptions): Session | ToolResult {
  const session = opts.getSession();
  if (session === null) {
    return json({ error: "tool invoked before session was initialized" }, true);
  }
  return session;
}

function parseForkTurns(value: unknown): ToolResult | ForkMode | undefined {
  const raw = value === undefined ? "all" : value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === "none") return undefined;
    if (trimmed.toLowerCase() === "all") return { kind: "full_history" };
    const parsed = Number.parseInt(trimmed, 10);
    if (String(parsed) === trimmed && parsed > 0) {
      return { kind: "last_n_turns", n: parsed };
    }
  }
  return json(
    { error: "fork_turns must be `none`, `all`, or a positive integer string" },
    true,
  );
}

function waitTimeoutMs(
  args: Record<string, unknown>,
  session: Session,
): ToolResult | number {
  const supplied = numberValue(args.timeout_ms) ?? numberValue(args.timeoutMs);
  if (supplied !== undefined && supplied <= 0) {
    return json({ error: "timeout_ms must be greater than zero" }, true);
  }
  const configuredMin = session.config?.multiAgentV2?.minWaitTimeoutMs;
  const minTimeoutMs = Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(1, configuredMin ?? MIN_WAIT_TIMEOUT_MS),
  );
  return Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(minTimeoutMs, supplied ?? DEFAULT_WAIT_TIMEOUT_MS),
  );
}

async function validateSpawnModelOverrides(opts: {
  readonly session: Session;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}): Promise<ToolResult | null> {
  if (opts.model === undefined && opts.reasoningEffort === undefined) {
    return null;
  }
  const modelsManager = opts.session.services.modelsManager;
  const currentModel = opts.session.modelInfo.slug;
  const model = opts.model ?? currentModel;
  if (opts.model !== undefined) {
    const listed =
      modelsManager.tryListModels() ?? (await modelsManager.listModels());
    if (!listed.some((candidate) => candidate.slug === opts.model)) {
      const available = listed.map((candidate) => candidate.slug).join(", ");
      return json(
        {
          error: `Unknown model \`${opts.model}\` for spawn_agent. Available models: ${available}`,
        },
        true,
      );
    }
  }
  if (
    opts.reasoningEffort !== undefined &&
    opts.reasoningEffort !== "none"
  ) {
    const modelInfo =
      opts.model === undefined
        ? opts.session.modelInfo
        : await modelsManager.getModelInfo(model);
    if (!modelInfo.supportedReasoningLevels.includes(opts.reasoningEffort)) {
      const supported = modelInfo.supportedReasoningLevels.join(", ");
      return json(
        {
          error: `Reasoning effort \`${opts.reasoningEffort}\` is not supported for model \`${model}\`. Supported reasoning efforts: ${supported}`,
        },
        true,
      );
    }
  }
  return null;
}

function createAgentTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const emit = (session: Session, msg: Parameters<Session["emit"]>[0]["msg"]): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg,
    });
  };

  const spawn = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const session = sessionOrError;
    const strict = strictArgs(args, {
      allowed: new Set([
        "message",
        "task_name",
        "agent_type",
        "model",
        "reasoning_effort",
        "fork_turns",
        "fork_context",
      ]),
      required: ["message", "task_name"],
    });
    if (strict) return strict;
    for (const key of [
      "message",
      "task_name",
      "agent_type",
      "model",
      "reasoning_effort",
      "fork_turns",
    ]) {
      if (args[key] !== undefined && typeof args[key] !== "string") {
        return json({ error: `${key} must be a string` }, true);
      }
    }
    if (
      args.fork_context !== undefined &&
      typeof args.fork_context !== "boolean"
    ) {
      return json({ error: "fork_context must be a boolean" }, true);
    }
    const prompt = stringValue(args.message);
    if (!prompt || prompt.trim().length === 0) {
      return json({ error: "message is required" }, true);
    }
    if (args.fork_context !== undefined) {
      return json(
        { error: "fork_context is not supported in MultiAgentV2; use fork_turns instead" },
        true,
      );
    }
    const { control, registry } = ensureAgentControl(session);
    const current = currentAgentContext(session, args);
    const rawRole =
      stringValue(args.agent_type) ??
      stringValue(args.agentType) ??
      stringValue(args.subagent_type) ??
      stringValue(args.role);
    const role = rawRole !== undefined ? canonicalAgentRoleName(rawRole) : undefined;
    const model = stringValue(args.model);
    const rawReasoningEffort = args.reasoning_effort ?? args.reasoningEffort;
    const reasoningEffort = parseReasoningEffort(rawReasoningEffort);
    if (rawReasoningEffort !== undefined && reasoningEffort === undefined) {
      return json({ error: "invalid reasoning_effort" }, true);
    }
    const forkMode = parseForkTurns(args.fork_turns ?? args.forkTurns);
    if (forkMode !== undefined && "content" in forkMode) return forkMode;
    if (
      forkMode?.kind === "full_history" &&
      (role !== undefined || model !== undefined || reasoningEffort !== undefined)
    ) {
      return json(
        {
          error:
            "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.",
        },
        true,
      );
    }
    try {
      if (role !== undefined) requireAgentRole(role);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    const overrideError = await validateSpawnModelOverrides({
      session,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    if (overrideError) return overrideError;
    const taskName = stringValue(args.task_name);
    if (!taskName) {
      return json({ error: "task_name is required" }, true);
    }
    try {
      assertValidAgentName(taskName);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    const childDepth = currentAgentDepth(session, current) + 1;
    const maxDepth = resolveSessionMaxAgentDepth(session);
    if (childDepth > maxDepth) {
      return json(
        { error: "Agent depth limit reached. Solve the task yourself." },
        true,
      );
    }
    const agentName = taskName;
    const runInBackground = true;
    const callId = callIdFromArgs(args, "agent");

    emit(session, {
      type: "collab_agent_spawn_begin",
      payload: {
        callId,
        senderThreadId: current.threadId,
        prompt,
        model: model ?? session.sessionConfiguration.collaborationMode.model,
        reasoningEffort:
          reasoningEffort ??
          session.sessionConfiguration.collaborationMode.reasoningEffort,
      },
    });

    let thread: AgentThread | undefined;
    try {
      const outcome = await delegate({
        parent: session,
        parentPath: current.agentPath,
        control,
        registry,
        taskPrompt: prompt,
        agentName,
        ...(forkMode !== undefined ? { forkMode } : {}),
        runInBackground,
        ...(role !== undefined ? { role } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
      if (outcome.kind === "rejected") {
        throw new Error(outcome.reason);
      }
      thread = outcome.thread;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emit(session, {
        type: "collab_agent_spawn_end",
        payload: {
          callId,
          senderThreadId: current.threadId,
          prompt,
          model: model ?? session.sessionConfiguration.collaborationMode.model,
          reasoningEffort:
            reasoningEffort ??
            session.sessionConfiguration.collaborationMode.reasoningEffort,
          status: { status: "errored", turnId: callId, endedAtMs: Date.now(), error: reason },
        },
      });
      return json({ error: reason }, true);
    }
    if (thread === undefined) {
      return json({ error: "spawn_agent did not return an agent thread" }, true);
    }
    try {
      registerAgentThreadTask(backgroundTaskLifecycle, thread, {
        toolUseId: callId,
        description: prompt,
      });
    } catch (error) {
      if (
        !(error instanceof BackgroundTaskError) ||
        error.code !== "already_exists"
      ) {
        throw error;
      }
    }
    const live = thread.live;
    emit(session, {
      type: "collab_agent_spawn_end",
      payload: {
        callId,
        senderThreadId: current.threadId,
        newThreadId: live.agentId,
        newAgentNickname: live.nickname,
        newAgentRole: live.role.name,
        newAgentRoleDisplayName: formatAgentRoleLabel(live.role.name),
        prompt,
        model: model ?? session.sessionConfiguration.collaborationMode.model,
        reasoningEffort:
          reasoningEffort ??
          session.sessionConfiguration.collaborationMode.reasoningEffort,
        status: live.status.value,
      },
    });
    recordAgentCounter(session, "agenc.multi_agent.spawn", [
      ["role", live.role.name],
    ]);

    return json({
      task_name: live.agentPath,
      ...(!hideSpawnAgentMetadata(session)
        ? { nickname: live.nickname ?? null }
        : {}),
    });
  };

  const waitForAgent = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, { allowed: new Set(["timeout_ms"]) });
    if (strict) return strict;
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const timeoutMs = waitTimeoutMs(args, sessionOrError);
    if (typeof timeoutMs !== "number") return timeoutMs;
    const current = currentAgentContext(sessionOrError, args);
    const waitCallId = callIdFromArgs(args, "wait");
    emit(sessionOrError, {
      type: "collab_waiting_begin",
      payload: {
        senderThreadId: current.threadId,
        receiverThreadIds: [],
        receiverAgents: [],
        callId: waitCallId,
      },
    });
    const changed =
      typeof sessionOrError.waitForMailboxChange === "function"
        ? await sessionOrError.waitForMailboxChange(timeoutMs)
        : await new Promise<boolean>((resolvePromise) =>
            setTimeout(() => resolvePromise(sessionOrError.mailbox.hasPending()), timeoutMs),
          );
    emit(sessionOrError, {
      type: "collab_waiting_end",
      payload: {
        senderThreadId: current.threadId,
        callId: waitCallId,
        statuses: {},
      },
    });
    return json({
      message: changed ? "Wait completed." : "Wait timed out.",
      timed_out: !changed,
    });
  };

  const closeAgent = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["target"]),
      required: ["target"],
    });
    if (strict) return strict;
    const target = stringValue(args.target);
    if (!target) return json({ error: "target is required" }, true);
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const current = currentAgentContext(sessionOrError, args);
    let agentId: ThreadId;
    try {
      agentId = resolveAgentId(sessionOrError, target, current.agentPath);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    if (agentId === sessionOrError.conversationId) {
      return json({ error: "root is not a spawned agent" }, true);
    }
    const callId = callIdFromArgs(args, "close");
    const receiverMetadata = receiverMetadataFor(sessionOrError, agentId);
    emit(sessionOrError, {
      type: "collab_close_begin",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        ...receiverMetadata,
      },
    });
    let previous: AgentStatus;
    try {
      const subscription = await control.subscribeStatus(agentId);
      previous = subscription.value;
      subscription.unsubscribe();
    } catch {
      previous =
        control.getLive(agentId)?.status.value ??
        (typeof (control as { getStatus?: unknown }).getStatus === "function"
          ? await control.getStatus(agentId)
          : { status: "not_found" });
    }
    await control.shutdown(agentId, "closed_by_tool");
    emit(sessionOrError, {
      type: "collab_close_end",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        ...receiverMetadata,
        status: previous as AgentStatus,
      },
    });
    return json({ previous_status: toAgentStatusJson(previous) });
  };

  const sendInput = async (
    args: Record<string, unknown>,
    optsForSend: {
      readonly triggerTurn: boolean;
      readonly aliasName: "followup_task" | "send_message";
    },
  ): Promise<ToolResult> => {
    if (optsForSend.aliasName === "send_message") {
      const strict = strictArgs(args, {
        allowed: new Set(["target", "message"]),
        required: ["target", "message"],
      });
      if (strict) return strict;
    } else if (optsForSend.aliasName === "followup_task") {
      const strict = strictArgs(args, {
        allowed: new Set(["target", "message"]),
        required: ["target", "message"],
      });
      if (strict) return strict;
    }
    const target = stringValue(args.target);
    const message = typeof args.message === "string" ? args.message : undefined;
    if (!target || !message) {
      return json({ error: "target and message are required" }, true);
    }
    if (message.trim().length === 0) {
      return json({ error: "Empty message can't be sent to an agent" }, true);
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const current = currentAgentContext(sessionOrError, args);
    let agentId: ThreadId;
    try {
      agentId = resolveAgentId(sessionOrError, target, current.agentPath);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    if (optsForSend.triggerTurn && agentId === sessionOrError.conversationId) {
      return json({ error: "Tasks can't be assigned to the root agent" }, true);
    }
    const callId = callIdFromArgs(args, "message");
    const live = control.getLive(agentId);
    const metadata = control.getAgentMetadata(agentId);
    const receiverAgentPath = metadata?.agentPath ?? live?.agentPath;
    if (!receiverAgentPath) {
      return json({ error: "target agent is missing an agent_path" }, true);
    }
    emit(sessionOrError, {
      type: "collab_agent_interaction_begin",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        prompt: message,
      },
    });
    let deliveryError: unknown;
    try {
      await control.sendInterAgentCommunication(agentId, {
        author: current.agentPath,
        recipient: receiverAgentPath,
        content: message,
        triggerTurn: optsForSend.triggerTurn,
      });
    } catch (error) {
      deliveryError = error;
    }
    const status = await control.getStatus(agentId);
    emit(sessionOrError, {
      type: "collab_agent_interaction_end",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        ...(live?.nickname !== undefined
          ? { receiverAgentNickname: live.nickname }
          : {}),
        ...(live?.role.name !== undefined
          ? { receiverAgentRole: live.role.name }
          : {}),
        ...(live?.role.name !== undefined
          ? { receiverAgentRoleDisplayName: formatAgentRoleLabel(live.role.name) }
          : {}),
        prompt: message,
        status,
      },
    });
    if (deliveryError !== undefined) {
      return json(
        {
          error:
            deliveryError instanceof Error
              ? deliveryError.message
              : String(deliveryError),
        },
        true,
      );
    }
    return { content: "" };
  };

  const listAgents = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["path_prefix"]),
    });
    if (strict) return strict;
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const current = currentAgentContext(sessionOrError, args);
    const pathPrefixRaw = stringValue(args.path_prefix);
    let resolvedPathPrefix: AgentPath | undefined;
    if (pathPrefixRaw !== undefined) {
      try {
        resolvedPathPrefix = resolveAgentPath(current.agentPath, pathPrefixRaw);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    }
    return json({
      agents: control.listAgents({
        ...(resolvedPathPrefix !== undefined ? { pathPrefix: resolvedPathPrefix } : {}),
      }).map(toListedAgentJson),
    });
  };

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

  const spawnAgentSchema = {
    type: "object",
    properties: {
      message: { type: "string" },
      task_name: { type: "string" },
      agent_type: {
        type: "string",
        description:
          "Optional role name. Accepts any registered built-in or user-defined role; defaults to `default` when omitted.",
      },
      model: { type: "string" },
      reasoning_effort: { type: "string" },
      fork_turns: { type: "string" },
    },
    required: ["message", "task_name"],
    additionalProperties: false,
  };

  return [
    {
      name: "spawn_agent",
      description: buildSpawnAgentDescription(opts.getSession()),
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "spawn", "delegate", "subagent"],
      }),
      requiresApproval: true,
      inputSchema: spawnAgentSchema,
      execute: spawn,
    },
    {
      name: "wait_agent",
      description:
        "Wait for new messages from any agent. Returns when a message is ready or timeout elapses.",
      metadata: toolMetadata("agent", { keywords: ["agent", "wait", "status"] }),
      isReadOnly: true,
      timeoutBehavior: "tool",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: {
            type: "number",
            description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
          },
        },
        additionalProperties: false,
      },
      execute: waitForAgent,
    },
    {
      name: "close_agent",
      description: "Close a spawned agent and its descendants.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "close", "stop"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: closeAgent,
    },
    {
      name: "followup_task",
      description:
        "Send a message to an existing non-root target agent and trigger a turn in that target. If the target is currently mid-turn, the message is queued and will be used to start the target's next turn, after the current turn completes.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "followup", "task"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      execute: (args) =>
        sendInput(args, { triggerTurn: true, aliasName: "followup_task" }),
    },
    {
      name: "send_message",
      description:
        "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "message", "mailbox"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
      execute: (args) =>
        sendInput(args, { triggerTurn: false, aliasName: "send_message" }),
    },
    {
      name: "list_agents",
      description:
        "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
      metadata: toolMetadata("agent", { keywords: ["agent", "list", "status"] }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          path_prefix: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: listAgents,
    },
    {
      name: "spawn_agents_on_csv",
      description:
        "Spawn one subagent per row of a CSV file. Each row is rendered into the instruction template (using `{column_name}` placeholders); the subagents must call `report_agent_job_result` exactly once with their analysis. Optionally writes an output CSV with each row's status and result.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "spawn", "batch", "csv", "job"],
      }),
      requiresApproval: true,
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

function createWebTools(opts: ModelFacingToolOptions): readonly Tool[] {
  return [
    {
      name: "WebFetch",
      description:
        "Fetch an HTTPS URL and return readable text content plus status and final URL.",
      metadata: toolMetadata("web", {
        keywords: ["web", "fetch", "url", "http"],
      }),
      isReadOnly: true,
      concurrencyClass: { kind: "shared_read" },
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
      execute: async (args) => {
        const url = stringValue(args.url);
        if (!url) return json({ error: "url is required" }, true);
        const normalized = normalizeUrl(url);
        const parsed = new URL(normalized);
        const preapproved = isPreapprovedHost(parsed.hostname, parsed.pathname);
        const response = await fetchWithTimeout(
          normalized,
          numberValue(args.timeout_ms) ?? DEFAULT_TIMEOUT_MS,
        );
        const contentType = response.headers.get("content-type") ?? "";
        const raw = await response.text();
        const isHtml = contentType.includes("html");
        let body: string;
        let renderedAs: "markdown" | "text" | "passthrough";
        if (isHtml) {
          try {
            body = await htmlToMarkdown(raw);
            renderedAs = "markdown";
          } catch {
            // Turndown / parser failure: fall back to the regex strip
            // so a single bad page doesn't break WebFetch entirely.
            body = htmlToText(raw);
            renderedAs = "text";
          }
        } else {
          body = raw;
          renderedAs = "passthrough";
        }
        const maxChars = Math.max(
          1_000,
          Math.min(numberValue(args.max_chars) ?? MAX_FETCH_CHARS, MAX_FETCH_CHARS),
        );
        const textBody =
          body.length > maxChars
            ? `${body.slice(0, maxChars)}\n\n[truncated ${body.length - maxChars} chars]`
            : body;
        return json({
          status: response.status,
          ok: response.ok,
          url: normalized,
          final_url: response.url,
          content_type: contentType,
          preapproved,
          rendered_as: renderedAs,
          prompt: stringValue(args.prompt),
          content: textBody,
        }, response.ok ? undefined : true);
      },
    },
    {
      name: "WebSearch",
      description:
        "Search the web for current information and return result titles, URLs, and snippets.",
      metadata: toolMetadata("web", {
        keywords: ["web", "search", "current", "sources"],
      }),
      isReadOnly: true,
      concurrencyClass: { kind: "shared_read" },
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

function createNotebookEditTool(opts: ModelFacingToolOptions): Tool {
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
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: { type: "string" },
        cell_id: { type: "string" },
        new_source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
      },
      required: ["notebook_path"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) return json({ error: "notebook_path is required" }, true);
      const editMode = stringValue(args.edit_mode) ?? "replace";
      const filePath = resolveWorkspacePath(opts, notebookPath);
      if (extname(filePath) !== ".ipynb") {
        return json({ error: "File must be a Jupyter notebook (.ipynb)" }, true);
      }
      const original = await readFile(filePath, "utf8");
      const notebook = JSON.parse(original) as {
        cells?: Array<Record<string, unknown>>;
        metadata?: Record<string, unknown>;
      };
      if (!Array.isArray(notebook.cells)) {
        return json({ error: "Notebook has no cells array" }, true);
      }
      const cellId = stringValue(args.cell_id);
      const index =
        cellId !== undefined
          ? notebook.cells.findIndex((cell) => cell.id === cellId)
          : editMode === "insert"
            ? -1
            : 0;
      if (editMode !== "insert" && index < 0) {
        return json({ error: `cell not found: ${cellId ?? "(first cell)"}` }, true);
      }
      const newSource = typeof args.new_source === "string" ? args.new_source : "";
      if (editMode === "delete") {
        notebook.cells.splice(index, 1);
      } else if (editMode === "insert") {
        const newCell = {
          cell_type: stringValue(args.cell_type) ?? "code",
          id: randomUUID().slice(0, 8),
          metadata: {},
          source: newSource.endsWith("\n") ? newSource : `${newSource}\n`,
          ...(stringValue(args.cell_type) === "markdown"
            ? {}
            : { execution_count: null, outputs: [] }),
        };
        notebook.cells.splice(index + 1, 0, newCell);
      } else {
        const cell = notebook.cells[index]!;
        cell.source = newSource.endsWith("\n") ? newSource : `${newSource}\n`;
        if (stringValue(args.cell_type) !== undefined) {
          cell.cell_type = stringValue(args.cell_type);
        }
      }
      const updated = `${JSON.stringify(notebook, null, 1)}\n`;
      await writeFile(filePath, updated, "utf8");
      return json({
        notebook_path: filePath,
        cell_id: cellId,
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
      "Inspect code with AgenC's semantic index and lightweight diagnostics.",
    metadata: toolMetadata("coding", {
      deferred: true,
      keywords: ["lsp", "diagnostics", "definition", "references"],
    }),
    isReadOnly: true,
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
        return json({
          file_path: resolved,
          diagnostics: exists && fileStat?.isFile() ? [] : [{
            severity: "error",
            message: "File not found",
          }],
          note:
            "No language server is configured in this runtime; diagnostics are limited to file availability.",
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
