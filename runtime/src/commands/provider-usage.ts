/**
 * The provider half of `/usage`: a "Providers" section for every connected
 * provider that has a balance or usage API, and `/usage <provider>` for one
 * provider in detail.
 *
 * Keys and base URLs come from the same authorities the provider menus use
 * (registry metadata, config `base_url`, environment overrides and saved
 * BYOK keys). Providers without a direct key are not listed, and a key is
 * never rendered. Lookups run in parallel; a failing provider becomes one
 * dim line and never holds up the others.
 */

import { readLocalByokCredential } from "../auth/native-credentials.js";
import { defaultConfig } from "../config/schema.js";
import { resolveProviderCredentialAuthority } from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import {
  displayText,
  fetchProviderUsage,
  isProviderUsageSlug,
  PROVIDER_USAGE_SLUGS,
  type CreditTotals,
  type DeepSeekBalance,
  type KimiBalance,
  type OllamaCloudBalance,
  type OllamaCloudUsage,
  type OllamaCloudUsageGroup,
  type OpenRouterKey,
  type ProviderUsageReport,
  type ProviderUsageSlug,
  type ProviderUsageTarget,
  type UsageMetrics,
  type UsageRead,
  type VeniceBalance,
} from "../llm/provider-usage-client.js";
import {
  providerApiKeyEnvironmentLabel,
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import { getProxyFetchOptions } from "../utils/proxy.js";
import { withSecureStorageDisplaySnapshot } from "../utils/secureStorage/index.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  requireCommandConfigStore,
} from "./config-context.js";
import type { SlashCommandContext, SlashCommandResult } from "./types.js";

export interface ProviderUsageOptions {
  /** Terminal columns. Defaults to the TUI's terminal, else 80. */
  readonly columns?: number;
  /** Dim failures and bold headings. Defaults to on inside the TUI only. */
  readonly styled?: boolean;
  readonly now?: Date;
  /** For deterministic dates in tests; the local zone otherwise. */
  readonly timeZone?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface UsageLayout {
  /** Columns available to text inside the TUI's bordered result box. */
  readonly width: number;
  readonly styled: boolean;
  readonly now: Date;
  readonly timeZone?: string;
}

type Tone = "dim" | "bold";

interface Line {
  readonly text: string;
  readonly tone?: Tone;
}

interface Row {
  readonly label: string;
  readonly value: string;
  readonly tone?: "dim";
}

interface Section {
  readonly title?: string;
  readonly rows: readonly Row[];
}

type ProviderView =
  | { readonly name: string; readonly sections: readonly Section[] }
  | { readonly name: string; readonly failure: string };

interface ProviderUsageCandidate {
  readonly provider: ProviderUsageSlug;
  readonly name: string;
  readonly target?: ProviderUsageTarget;
}

/** The transient result box draws a border and one column of padding per side. */
const RESULT_BOX_CHROME = 4;
const MIN_TEXT_WIDTH = 24;
/** Below this many value columns, rows stack instead of sharing a line. */
const MIN_VALUE_COLUMNS = 34;
const TOP_MODEL_COUNT = 2;
const MAX_MODEL_LABEL = 32;
/** Ollama Cloud reports its web tools as usage groups beside the models. */
const OLLAMA_TOOL_GROUPS: Readonly<Record<string, string>> = {
  web_search: "web search",
  web_fetch: "web fetch",
};

function providerName(provider: ProviderUsageSlug): string {
  return resolveBuiltInProviderInfo(provider)?.name ?? provider;
}

function resolveLayout(ctx: SlashCommandContext, options: ProviderUsageOptions): UsageLayout {
  const columns = options.columns ?? (process.stdout.columns || 80);
  return {
    width: Math.max(MIN_TEXT_WIDTH, columns - RESULT_BOX_CHROME),
    styled: options.styled ?? typeof ctx.appState?.setToolJSX === "function",
    now: options.now ?? new Date(),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  };
}

function styleLine(line: Line, styled: boolean): string {
  if (!styled || line.tone === undefined) return line.text;
  return line.tone === "dim"
    ? `\u001b[2m${line.text}\u001b[22m`
    : `\u001b[1m${line.text}\u001b[22m`;
}

function renderLines(lines: readonly Line[], layout: UsageLayout): string {
  return lines.map((line) => styleLine(line, layout.styled)).join("\n");
}

/** A section heading, bold inside the TUI. */
export function usageHeading(ctx: SlashCommandContext, title: string): string {
  return styleLine({ text: title, tone: "bold" }, resolveLayout(ctx, {}).styled);
}

const SEPARATOR = " · ";

interface Atom {
  readonly text: string;
  /** Joins this atom to the previous one when both share a line. */
  readonly joiner: string;
}

/**
 * Break text into the pieces a line may end after: whole `·`-separated parts
 * when they fit, else their words, else slices of a word too long for a line.
 */
function atoms(text: string, width: number): Atom[] {
  return text.split(SEPARATOR).flatMap((part, partIndex): Atom[] => {
    const partJoiner = partIndex === 0 ? "" : SEPARATOR;
    if (part.length <= width) return [{ text: part, joiner: partJoiner }];
    return part.split(" ").filter((word) => word.length > 0).flatMap((word, wordIndex) => {
      const slices: Atom[] = [];
      for (let start = 0; start < word.length; start += width) {
        const joiner = start > 0 ? "" : wordIndex === 0 ? partJoiner : " ";
        slices.push({ text: word.slice(start, start + width), joiner });
      }
      return slices;
    });
  });
}

/**
 * Greedy wrap that prefers to break between `·`-separated parts and drops the
 * separator at a break. The first line may be narrower than the rest.
 */
function wrap(text: string, firstWidth: number, restWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const atom of atoms(text, Math.max(1, Math.min(firstWidth, restWidth)))) {
    const width = Math.max(1, lines.length === 0 ? firstWidth : restWidth);
    if (current.length > 0 && current.length + atom.joiner.length + atom.text.length > width) {
      lines.push(current);
      current = atom.text;
    } else {
      current = current.length === 0 ? atom.text : `${current}${atom.joiner}${atom.text}`;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Lay out one block of text whose first line starts after `lead` and whose
 * continuation lines start after `indent` spaces.
 */
function hanging(lead: string, text: string, indent: number, width: number, tone?: Tone): Line[] {
  const toned = (value: string): Line => (tone === undefined ? { text: value } : { text: value, tone });
  return wrap(text, width - lead.length, width - indent).map((part, index) =>
    toned(index === 0 ? `${lead}${part}` : `${" ".repeat(indent)}${part}`));
}

function labelColumn(labels: readonly string[]): number {
  return Math.max(0, ...labels.map((label) => label.length)) + 3;
}

/** Rows as aligned columns when they fit, else `label: value` lines. */
function renderRows(rows: readonly Row[], width: number): Line[] {
  const column = labelColumn(rows.map((row) => row.label));
  if (width - column >= MIN_VALUE_COLUMNS) {
    return rows.flatMap((row) =>
      hanging(row.label.padEnd(column), row.value, column, width, row.tone));
  }
  return rows.flatMap((row) => hanging(`${row.label}: `, row.value, 2, width, row.tone));
}

function failureText(reason: string): string {
  return `usage unavailable (${reason})`;
}

/** The Providers section: one block per provider, value lines beside the name. */
function renderSummary(views: readonly ProviderView[], layout: UsageLayout): Line[] {
  const width = layout.width;
  const column = labelColumn(views.map((view) => view.name));
  const wide = width - column >= MIN_VALUE_COLUMNS;
  return views.flatMap((view): Line[] => {
    if ("failure" in view) {
      return wide
        ? hanging(view.name.padEnd(column), failureText(view.failure), column, width, "dim")
        : hanging(`${view.name}: `, failureText(view.failure), 2, width, "dim");
    }
    const entries = view.sections.flatMap((section) => section.rows)
      .map((row) => ({ text: `${row.label}: ${row.value}`, tone: row.tone }));
    if (wide) {
      return entries.flatMap((entry, index) =>
        hanging(index === 0 ? view.name.padEnd(column) : " ".repeat(column), entry.text, column + 2, width, entry.tone));
    }
    return [
      { text: view.name },
      ...entries.flatMap((entry) => hanging("  ", entry.text, 4, width, entry.tone)),
    ];
  });
}

function renderDetail(view: ProviderView, layout: UsageLayout): Line[] {
  if ("failure" in view) {
    return [{ text: view.name, tone: "bold" }, { text: failureText(view.failure), tone: "dim" }];
  }
  const lines: Line[] = [{ text: view.name, tone: "bold" }];
  view.sections.forEach((section, index) => {
    if (section.title !== undefined) {
      if (index > 0) lines.push({ text: "" });
      lines.push({ text: section.title, tone: "bold" });
    }
    lines.push(...renderRows(section.rows, layout.width));
  });
  return lines;
}

function money(value: number, currency = "USD"): string {
  if (value < 0) return `-${money(-value, currency)}`;
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : undefined;
  if (value > 0 && value < 0.005) return `<${symbol ?? ""}0.01${symbol === undefined ? ` ${currency}` : ""}`;
  const digits = amount(value);
  return symbol === undefined ? `${digits} ${currency}` : `${symbol}${digits}`;
}

function amount(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function integer(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function plural(value: number, noun: string): string {
  return `${integer(value)} ${noun}${Math.round(value) === 1 ? "" : "s"}`;
}

function compact(value: number): string {
  for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return integer(value);
}

function formatter(layout: UsageLayout, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    ...(layout.timeZone === undefined ? {} : { timeZone: layout.timeZone }),
  });
}

function day(iso: string, layout: UsageLayout): string {
  const date = new Date(iso);
  const year = formatter(layout, { year: "numeric" });
  const sameYear = year.format(date) === year.format(layout.now);
  return formatter(layout, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

function dayTime(iso: string, layout: UsageLayout): string {
  const time = formatter(layout, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return `${day(iso, layout)}, ${time}`;
}

function unavailable(reason: string): string {
  return `unavailable (${reason})`;
}

function metricsText(metrics: UsageMetrics): string {
  if (metrics.requestCount === 0) return "no requests";
  const parts = [plural(metrics.requestCount, "request")];
  if (metrics.usageUsd !== undefined) parts.push(money(metrics.usageUsd));
  if (metrics.inputTokens !== undefined) {
    const tokens = metrics.inputTokens + (metrics.outputTokens ?? 0);
    const cached = metrics.cachedInputTokens !== undefined && metrics.inputTokens > 0
      ? ` (${Math.round((metrics.cachedInputTokens / metrics.inputTokens) * 100)}% cached)`
      : "";
    parts.push(`${compact(tokens)} tokens${cached}`);
  }
  return parts.join(SEPARATOR);
}

function groupText(group: UsageMetrics): string {
  const parts: string[] = [];
  if (group.usageUsd !== undefined) parts.push(money(group.usageUsd));
  parts.push(plural(group.requestCount, "request"));
  if (group.inputTokens !== undefined) {
    parts.push(`${compact(group.inputTokens + (group.outputTokens ?? 0))} tokens`);
  }
  return parts.join(SEPARATOR);
}

/** Web search and fetch bill per request; they carry no tokens. */
function toolText(group: UsageMetrics): string {
  const spend = group.usageUsd === undefined ? "" : `${SEPARATOR}${money(group.usageUsd)}`;
  return `${plural(group.requestCount, "request")}${spend} in the last 7d`;
}

function modelGroups(usage: OllamaCloudUsage): OllamaCloudUsageGroup[] {
  return usage.groups.filter((group) => OLLAMA_TOOL_GROUPS[group.model] === undefined);
}

function truncateLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length <= MAX_MODEL_LABEL ? label : `${chars.slice(0, MAX_MODEL_LABEL - 1).join("")}…`;
}

function ollamaPlanRows(balance: OllamaCloudBalance, layout: UsageLayout, detail: boolean): Row[] {
  const rows: Row[] = [];
  const included = balance.included;
  if (included?.kind === "credits") {
    const left = `${money(included.balanceUsd)} of ${money(included.allowanceUsd)} left`;
    if (detail) {
      rows.push({ label: "plan", value: left });
      if (included.periodFrom !== undefined && included.periodUntil !== undefined) {
        rows.push({ label: "period", value: `${day(included.periodFrom, layout)} to ${day(included.periodUntil, layout)}` });
      }
    } else {
      const resets = included.periodUntil === undefined ? "" : ` (resets ${day(included.periodUntil, layout)})`;
      rows.push({ label: "plan", value: `${left}${resets}` });
    }
  } else if (included?.kind === "limits") {
    // Legacy plans: a short session window (the hour matters) and a week.
    const limits = [
      { name: "session", limit: included.session, when: dayTime },
      { name: "week", limit: included.weekly, when: day },
    ].flatMap(({ name, limit, when }) => limit === undefined ? [] : [{
      name,
      left: `${integer(limit.remainingPercent)}% left`,
      resets: limit.resetsAt === undefined ? undefined : when(limit.resetsAt, layout),
    }]);
    if (detail) {
      rows.push(...limits.map(({ name, left, resets }) =>
        ({ label: name, value: resets === undefined ? left : `${left}, resets ${resets}` })));
    } else {
      rows.push({
        label: "plan",
        value: limits.map(({ name, left, resets }) =>
          `${name} ${left}${resets === undefined ? "" : ` (resets ${resets})`}`).join(SEPARATOR),
      });
    }
  }
  if (balance.purchasedUsd !== undefined) {
    rows.push({ label: "purchased", value: money(balance.purchasedUsd) });
  }
  return rows;
}

function topModels(usage: OllamaCloudUsage): string | undefined {
  const top = modelGroups(usage).slice(0, TOP_MODEL_COUNT);
  if (top.length === 0) return undefined;
  return top.map((group) =>
    `${group.model} ${group.usageUsd !== undefined ? money(group.usageUsd) : plural(group.requestCount, "request")}`)
    .join(SEPARATOR);
}

function ollamaView(
  name: string,
  report: Extract<ProviderUsageReport, { provider: "ollama-cloud" }>,
  layout: UsageLayout,
  detail: boolean,
): ProviderView {
  const { balance, last24h, last7d } = report;
  if (!balance.ok && !last24h.ok) return { name, failure: balance.reason };
  const rows: Row[] = balance.ok
    ? ollamaPlanRows(balance.value, layout, detail)
    : [{ label: "plan", value: unavailable(balance.reason), tone: "dim" }];
  rows.push(last24h.ok
    ? { label: "last 24h", value: metricsText(last24h.value.totals) }
    : { label: "last 24h", value: unavailable(last24h.reason), tone: "dim" });
  if (!detail) {
    const top = last24h.ok ? topModels(last24h.value) : undefined;
    if (top !== undefined) rows.push({ label: "top models", value: top });
    return { name, sections: [{ rows }] };
  }
  if (last7d === undefined) return { name, sections: [{ rows }] };
  if (!last7d.ok) {
    rows.push({ label: "last 7d", value: unavailable(last7d.reason), tone: "dim" });
    return { name, sections: [{ rows }] };
  }
  rows.push({ label: "last 7d", value: metricsText(last7d.value.totals) });
  for (const [group, label] of Object.entries(OLLAMA_TOOL_GROUPS)) {
    const tool = last7d.value.groups.find((entry) => entry.model === group);
    if (tool !== undefined) rows.push({ label, value: toolText(tool) });
  }
  const models: Row[] = modelGroups(last7d.value).map((group) => ({
    label: truncateLabel(group.model),
    value: groupText(group),
  }));
  if (last7d.value.remainder !== undefined && last7d.value.remainder.requestCount > 0) {
    models.push({ label: "other models", value: groupText(last7d.value.remainder) });
  }
  return {
    name,
    sections: [{ rows }, ...(models.length === 0 ? [] : [{ title: "Models, last 7d", rows: models }])],
  };
}

function openRouterKeyRows(key: OpenRouterKey, layout: UsageLayout): Row[] {
  const rows: Row[] = [];
  const spend = [
    [key.usageDaily, "today"],
    [key.usageWeekly, "this week"],
    [key.usageMonthly, "this month"],
    [key.usage, "in total"],
  ] as const;
  const spent = spend.flatMap(([value, label]) => value === undefined ? [] : [`${money(value)} ${label}`]);
  if (spent.length > 0) rows.push({ label: "this key", value: spent.join(SEPARATOR) });
  if (key.limit === null) rows.push({ label: "key limit", value: "none" });
  else if (key.limit !== undefined) {
    const left = key.limitRemaining === undefined || key.limitRemaining === null
      ? money(key.limit)
      : `${money(key.limitRemaining)} left of ${money(key.limit)}`;
    rows.push({ label: "key limit", value: `${left}${key.limitReset === undefined ? "" : `, resets ${key.limitReset}`}` });
  }
  if (key.byokUsageMonthly !== undefined && key.byokUsageMonthly > 0) {
    rows.push({ label: "BYOK usage", value: `${money(key.byokUsageMonthly)} this month` });
  }
  if (key.freeModelRequests !== undefined) {
    rows.push({
      label: "free models",
      value: `${integer(key.freeModelRequests.used)} of ${plural(key.freeModelRequests.limit, "request")} used today`,
    });
  }
  if (key.expiresAt !== undefined) rows.push({ label: "key expires", value: day(key.expiresAt, layout) });
  return rows;
}

function openRouterView(
  name: string,
  report: Extract<ProviderUsageReport, { provider: "openrouter" }>,
  layout: UsageLayout,
  detail: boolean,
): ProviderView {
  const { credits, key } = report;
  if (!credits.ok && !key.ok) return { name, failure: key.reason };
  const creditRows: Row[] = credits.ok
    ? [{ label: "credits", value: creditsLeft(credits.value) }]
    : [];
  if (!detail) {
    if (creditRows.length > 0 || !key.ok) return { name, sections: [{ rows: creditRows }] };
    // Without the account's credits, say what this key has spent.
    const limit = key.value.limit;
    const fallback: Row = limit !== undefined && limit !== null && typeof key.value.limitRemaining === "number"
      ? { label: "key limit", value: `${money(key.value.limitRemaining)} left of ${money(limit)}` }
      : { label: "this key", value: `${money(key.value.usageMonthly ?? key.value.usage ?? 0)} used this month` };
    return { name, sections: [{ rows: [fallback] }] };
  }
  const rows: Row[] = credits.ok
    ? [...creditRows, { label: "used", value: money(credits.value.totalUsage) }]
    : [{ label: "credits", value: unavailable(credits.reason), tone: "dim" }];
  rows.push(...(key.ok
    ? openRouterKeyRows(key.value, layout)
    : [{ label: "this key", value: unavailable(key.reason), tone: "dim" as const }]));
  return { name, sections: [{ rows }] };
}

function singleRead<T>(
  name: string,
  read: UsageRead<T>,
  rows: (value: T) => Row[],
): ProviderView {
  return read.ok ? { name, sections: [{ rows: rows(read.value) }] } : { name, failure: read.reason };
}

/** A row only when its value is known. */
function optionalRow(label: string, value: string | undefined): Row[] {
  return value === undefined ? [] : [{ label, value }];
}

function creditsLeft(credits: CreditTotals): string {
  return `${money(credits.totalCredits - credits.totalUsage)} left of ${money(credits.totalCredits)}`;
}

function deepSeekRows(balance: DeepSeekBalance, detail: boolean): Row[] {
  if (!detail) {
    const total = balance.balances.length === 0
      ? "none"
      : balance.balances.map((entry) => money(entry.total, entry.currency)).join(SEPARATOR);
    const blocked = balance.isAvailable === false ? `${SEPARATOR}too low for API calls` : "";
    return [{ label: "balance", value: `${total}${blocked}` }];
  }
  const suffix = (currency: string) => (balance.balances.length > 1 ? ` (${currency})` : "");
  const rows = balance.balances.flatMap((entry): Row[] => [
    { label: `balance${suffix(entry.currency)}`, value: money(entry.total, entry.currency) },
    ...optionalRow(`granted${suffix(entry.currency)}`,
      entry.granted === undefined ? undefined : money(entry.granted, entry.currency)),
    ...optionalRow(`topped up${suffix(entry.currency)}`,
      entry.toppedUp === undefined ? undefined : money(entry.toppedUp, entry.currency)),
  ]);
  if (balance.balances.length === 0) rows.push({ label: "balance", value: "none" });
  return [
    ...rows,
    ...optionalRow("API calls",
      balance.isAvailable === undefined ? undefined : balance.isAvailable ? "allowed" : "blocked, balance too low"),
  ];
}

function veniceRows(balance: VeniceBalance, layout: UsageLayout, detail: boolean): Row[] {
  if (!detail) {
    const parts = [
      ...(balance.usd === undefined ? [] : [money(balance.usd)]),
      ...(balance.diem !== undefined && balance.diem > 0 ? [`${amount(balance.diem)} DIEM`] : []),
      ...(balance.bundledCreditsUsd !== undefined && balance.bundledCreditsUsd > 0
        ? [`${money(balance.bundledCreditsUsd)} bundled`]
        : []),
    ];
    return [{ label: "balance", value: parts.length > 0 ? parts.join(SEPARATOR) : money(0) }];
  }
  // DIEM is a daily compute allowance that refreshes at each epoch.
  const refresh = balance.nextEpochBegins === undefined ? "" : ` (refreshes ${day(balance.nextEpochBegins, layout)})`;
  return [
    ...optionalRow("USD", balance.usd === undefined ? undefined : money(balance.usd)),
    ...optionalRow("DIEM", balance.diem === undefined ? undefined : `${amount(balance.diem)}${refresh}`),
    ...optionalRow("bundled credits",
      balance.bundledCreditsUsd === undefined ? undefined : money(balance.bundledCreditsUsd)),
    ...optionalRow("API tier", balance.apiTier),
    ...optionalRow("API access",
      balance.accessPermitted === undefined ? undefined : balance.accessPermitted ? "allowed" : "blocked"),
    ...optionalRow("key expires",
      balance.keyExpiration === undefined ? undefined
        : balance.keyExpiration === null ? "never" : day(balance.keyExpiration, layout)),
  ];
}

function kimiRows(balance: KimiBalance, detail: boolean): Row[] {
  // A negative cash balance is money owed to Kimi.
  const owed = balance.cash !== undefined && balance.cash < 0 ? -balance.cash : undefined;
  if (!detail) {
    const owing = owed === undefined ? "" : `${SEPARATOR}${money(owed)} owed`;
    return [{ label: "balance", value: `${money(balance.available)} available${owing}` }];
  }
  return [
    { label: "available", value: money(balance.available) },
    ...optionalRow("voucher", balance.voucher === undefined ? undefined : money(balance.voucher)),
    ...optionalRow("cash", balance.cash === undefined
      ? undefined
      : `${money(balance.cash)}${owed === undefined ? "" : " (owed)"}`),
  ];
}

function providerView(
  name: string,
  report: ProviderUsageReport,
  layout: UsageLayout,
  detail: boolean,
): ProviderView {
  switch (report.provider) {
    case "ollama-cloud":
      return ollamaView(name, report, layout, detail);
    case "openrouter":
      return openRouterView(name, report, layout, detail);
    case "deepseek":
      return singleRead(name, report.balance, (balance) => deepSeekRows(balance, detail));
    case "venice":
      return singleRead(name, report.balance, (balance) => veniceRows(balance, layout, detail));
    case "kimi":
      return singleRead(name, report.balance, (balance) => kimiRows(balance, detail));
    case "abliteration":
      return singleRead(name, report.credits, (credits) => [
        { label: "credits", value: creditsLeft(credits) },
        ...(detail ? [{ label: "used", value: money(credits.totalUsage) }] : []),
      ]);
  }
}

/**
 * Direct keys only: an environment variable or a saved BYOK key, resolved the
 * way the provider itself resolves them.
 */
function resolveCandidates(
  ctx: SlashCommandContext,
  providers: readonly ProviderUsageSlug[],
): ProviderUsageCandidate[] {
  const configStore = requireCommandConfigStore(ctx);
  const home = configStore.homeContext;
  const config = readCommandConfig(ctx) ?? configStore.current() ?? defaultConfig();
  const environment = providerEnvironmentFromCommandContext(ctx);
  return withSecureStorageDisplaySnapshot(home, () => providers.map((provider): ProviderUsageCandidate => {
    const info = resolveBuiltInProviderInfo(provider);
    const name = info?.name ?? provider;
    if (info === undefined) return { provider, name };
    try {
      const requested = resolveProviderRuntimeRequest({
        provider,
        model: info.defaultModel,
        config,
        environment,
        credentialHome: home,
      }).requested;
      const authority = resolveProviderCredentialAuthority(provider, requested, environment, {
        savedApiKey: readLocalByokCredential(home, provider)?.apiKey,
      });
      const apiKey = authority.factoryOptions.apiKey?.trim();
      if (authority.credential.status !== "ready" || authority.credential.mode !== "api-key" || !apiKey) {
        return { provider, name };
      }
      return {
        provider,
        name,
        target: { provider, baseURL: authority.factoryOptions.baseURL ?? info.baseURL, apiKey },
      };
    } catch {
      // A provider whose configuration does not resolve has no usable key here.
      return { provider, name };
    }
  }));
}

/** One reader per command run, so every lookup shares the session's proxy and TLS dispatcher. */
function usageReader(
  ctx: SlashCommandContext,
  options: ProviderUsageOptions,
  detail: boolean,
): (target: ProviderUsageTarget) => Promise<ProviderUsageReport> {
  const fetchOptions = getProxyFetchOptions({ environment: providerEnvironmentFromCommandContext(ctx) });
  return (target) => fetchProviderUsage(target, {
    detail,
    fetchOptions,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function supportedNames(): string {
  const names = PROVIDER_USAGE_SLUGS.map(providerName);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The "Providers" section of `/usage`, heading included. */
export async function readProviderUsageSection(
  ctx: SlashCommandContext,
  options: ProviderUsageOptions = {},
): Promise<string> {
  const layout = resolveLayout(ctx, options);
  const connected = resolveCandidates(ctx, PROVIDER_USAGE_SLUGS)
    .flatMap((candidate) => candidate.target === undefined ? [] : [{ ...candidate, target: candidate.target }]);
  const heading: Line = { text: "Providers", tone: "bold" };
  if (connected.length === 0) {
    return renderLines([
      heading,
      ...hanging("", `No provider with a usage API is connected. /usage can read ${supportedNames()}.`, 0, layout.width, "dim"),
    ], layout);
  }
  const read = usageReader(ctx, options, false);
  const views = await Promise.all(connected.map(async (candidate) =>
    providerView(candidate.name, await read(candidate.target), layout, false)));
  return renderLines([heading, ...renderSummary(views, layout)], layout);
}

type UsageArgument =
  | { readonly kind: "supported"; readonly provider: ProviderUsageSlug }
  | { readonly kind: "unsupported"; readonly name: string }
  | { readonly kind: "unknown" };

function resolveUsageArgument(argument: string): UsageArgument {
  let slug: string | undefined;
  try {
    slug = resolveBuiltInProviderSlug(argument);
  } catch {
    return { kind: "unknown" };
  }
  if (slug === undefined) return { kind: "unknown" };
  // Local Ollama has no account. "/usage ollama" means the Ollama Cloud account.
  const provider = slug === "ollama" ? "ollama-cloud" : slug;
  if (isProviderUsageSlug(provider)) return { kind: "supported", provider };
  return { kind: "unsupported", name: resolveBuiltInProviderInfo(provider)?.name ?? provider };
}

/** `/usage <provider>`: one provider in detail. */
export async function readProviderUsageDetail(
  ctx: SlashCommandContext,
  argument: string,
  options: ProviderUsageOptions = {},
): Promise<SlashCommandResult> {
  const layout = resolveLayout(ctx, options);
  const resolved = resolveUsageArgument(argument);
  if (resolved.kind === "unknown") {
    const shown = displayText(argument, 40) ?? "";
    return {
      kind: "error",
      message: `Unknown provider "${shown}". Try ${PROVIDER_USAGE_SLUGS.map((slug) => slug === "ollama-cloud" ? "ollama" : slug).join(", ")}.`,
    };
  }
  if (resolved.kind === "unsupported") {
    return { kind: "text", text: `${resolved.name} has no balance or usage API that works with an API key.` };
  }
  const [candidate] = resolveCandidates(ctx, [resolved.provider]);
  const name = candidate?.name ?? providerName(resolved.provider);
  if (candidate?.target === undefined) {
    const envLabel = providerApiKeyEnvironmentLabel(resolved.provider);
    return {
      kind: "text",
      text: `${name} is not connected. ${envLabel === undefined ? "Connect it" : `Set ${envLabel}, or connect it`} in /provider.`,
    };
  }
  const report = await usageReader(ctx, options, true)(candidate.target);
  return { kind: "text", text: renderLines(renderDetail(providerView(name, report, layout, true), layout), layout) };
}
