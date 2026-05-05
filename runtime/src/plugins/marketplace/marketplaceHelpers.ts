import {
  type Marketplace,
  type MarketplaceSource,
} from "./marketplace.js";

const MAX_POLICY_PATTERN_LENGTH = 256;
const MAX_POLICY_PATTERN_VALUE_LENGTH = 2048;

export interface MarketplacePolicy {
  readonly strictKnownMarketplaces?: readonly MarketplaceSource[];
  readonly blockedMarketplaces?: readonly MarketplaceSource[];
  readonly pluginTrustMessage?: string;
}

export function formatFailureDetails(
  failures: readonly { readonly name: string; readonly reason?: string; readonly error?: string }[],
  includeReasons: boolean,
): string {
  const maxShow = 2;
  const details = failures
    .slice(0, maxShow)
    .map((failure) => {
      const reason = failure.reason ?? failure.error ?? "unknown error";
      return includeReasons ? `${failure.name} (${reason})` : failure.name;
    })
    .join(includeReasons ? "; " : ", ");
  const remaining = failures.length - maxShow;
  return `${details}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

export function getMarketplaceSourceDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case "github":
      return source.repo;
    case "git":
    case "url":
      return source.url;
    case "local":
    case "file":
    case "directory":
      return source.path;
    case "settings":
      return `settings:${source.name}`;
  }
}

export function createPluginId(pluginName: string, marketplaceName: string): string {
  return `${pluginName}@${marketplaceName}`;
}

export async function loadMarketplacesWithGracefulDegradation(
  config: Readonly<Record<string, { readonly source: MarketplaceSource }>>,
  getMarketplace: (marketplaceName: string) => Promise<Marketplace>,
  policy: MarketplacePolicy = {},
): Promise<{
  readonly marketplaces: readonly {
    readonly name: string;
    readonly config: { readonly source: MarketplaceSource };
    readonly data: Marketplace | null;
  }[];
  readonly failures: readonly { readonly name: string; readonly error: string }[];
}> {
  const marketplaces: {
    readonly name: string;
    readonly config: { readonly source: MarketplaceSource };
    readonly data: Marketplace | null;
  }[] = [];
  const failures: { readonly name: string; readonly error: string }[] = [];
  for (const [name, marketplaceConfig] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isSourceAllowedByPolicy(marketplaceConfig.source, policy)) continue;
    let data: Marketplace | null = null;
    try {
      data = await getMarketplace(name);
    } catch (error) {
      failures.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    marketplaces.push({ name, config: marketplaceConfig, data });
  }
  return { marketplaces, failures };
}

export function formatMarketplaceLoadingErrors(
  failures: readonly { readonly name: string; readonly error: string }[],
  successCount: number,
): { readonly type: "warning" | "error"; readonly message: string } | null {
  if (failures.length === 0) return null;
  if (successCount > 0) {
    return {
      type: "warning",
      message: failures.length === 1
        ? `Warning: Failed to load marketplace '${failures[0]!.name}': ${failures[0]!.error}`
        : `Warning: Failed to load ${failures.length} marketplaces: ${failures.map((failure) => failure.name).join(", ")}`,
    };
  }
  return {
    type: "error",
    message: `Failed to load all marketplaces. Errors: ${failures.map((failure) => `${failure.name}: ${failure.error}`).join("; ")}`,
  };
}

export function getStrictKnownMarketplaces(policy: MarketplacePolicy = {}): readonly MarketplaceSource[] | null {
  return policy.strictKnownMarketplaces ?? null;
}

export function getBlockedMarketplaces(policy: MarketplacePolicy = {}): readonly MarketplaceSource[] | null {
  return policy.blockedMarketplaces ?? null;
}

export function getPluginTrustMessage(policy: MarketplacePolicy = {}): string | undefined {
  return policy.pluginTrustMessage;
}

export function extractHostFromSource(source: MarketplaceSource): string | null {
  switch (source.source) {
    case "github":
      return "github.com";
    case "git":
    case "url":
      return extractHostFromUrlOrSsh(source.url);
    default:
      return null;
  }
}

export function getHostPatternsFromAllowlist(policy: MarketplacePolicy = {}): string[] {
  return (policy.strictKnownMarketplaces ?? [])
    .filter((entry): entry is MarketplaceSource & { readonly source: "settings"; readonly name: string } =>
      entry.source === "settings" && entry.name.startsWith("hostPattern:"),
    )
    .map((entry) => entry.name.slice("hostPattern:".length));
}

export function isSourceInBlocklist(
  source: MarketplaceSource,
  policy: MarketplacePolicy = {},
): boolean {
  return (policy.blockedMarketplaces ?? []).some((blocked) =>
    areSourcesEquivalentForBlocklist(source, blocked),
  );
}

export function isSourceAllowedByPolicy(
  source: MarketplaceSource,
  policy: MarketplacePolicy = {},
): boolean {
  if (isSourceInBlocklist(source, policy)) return false;
  const allowlist = policy.strictKnownMarketplaces;
  if (allowlist === undefined) return true;
  return allowlist.some((allowed) => {
    const hostPattern = getSettingsPattern(allowed, "hostPattern:");
    if (hostPattern !== null) {
      const host = extractHostFromSource(source);
      if (host === null) return false;
      return matchesPolicyPattern(hostPattern, host);
    }
    const pathPattern = getSettingsPattern(allowed, "pathPattern:");
    if (pathPattern !== null) {
      const path = source.source === "file" || source.source === "directory" || source.source === "local"
        ? source.path
        : null;
      return path !== null && matchesPolicyPattern(pathPattern, path);
    }
    return areSourcesEqual(source, allowed);
  });
}

export function formatSourceForDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case "github":
      return `github:${source.repo}${source.ref ? `@${source.ref}` : ""}`;
    case "url":
      return source.url;
    case "git":
      return `git:${source.url}${source.ref ? `@${source.ref}` : ""}`;
    case "file":
      return `file:${source.path}`;
    case "directory":
    case "local":
      return `dir:${source.path}`;
    case "settings":
      return `settings:${source.name}`;
  }
}

export type EmptyMarketplaceReason =
  | "git-not-installed"
  | "all-blocked-by-policy"
  | "policy-restricts-sources"
  | "all-marketplaces-failed"
  | "no-marketplaces-configured"
  | "all-plugins-installed";

export async function detectEmptyMarketplaceReason({
  configuredMarketplaceCount,
  failedMarketplaceCount,
  gitAvailable,
  policy = {},
}: {
  readonly configuredMarketplaceCount: number;
  readonly failedMarketplaceCount: number;
  readonly gitAvailable: boolean | (() => Promise<boolean>);
  readonly policy?: MarketplacePolicy;
}): Promise<EmptyMarketplaceReason> {
  const available = typeof gitAvailable === "boolean" ? gitAvailable : await gitAvailable();
  if (!available) return "git-not-installed";
  const allowlist = getStrictKnownMarketplaces(policy);
  if (allowlist !== null) {
    if (allowlist.length === 0) return "all-blocked-by-policy";
    if (configuredMarketplaceCount === 0) return "policy-restricts-sources";
  }
  if (configuredMarketplaceCount === 0) return "no-marketplaces-configured";
  if (failedMarketplaceCount > 0 && failedMarketplaceCount === configuredMarketplaceCount) {
    return "all-marketplaces-failed";
  }
  return "all-plugins-installed";
}

function areSourcesEqual(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false;
  switch (a.source) {
    case "github": {
      const right = b as typeof a;
      return a.repo === right.repo && optionalEq(a.ref, right.ref) && optionalEq(a.path, right.path);
    }
    case "git": {
      const right = b as typeof a;
      return a.url === right.url && optionalEq(a.ref, right.ref) && optionalEq(a.sparse, right.sparse);
    }
    case "url":
      return a.url === (b as typeof a).url;
    case "file":
    case "directory":
    case "local":
      return a.path === (b as typeof a).path;
    case "settings":
      return a.name === (b as typeof a).name;
  }
}

function areSourcesEquivalentForBlocklist(source: MarketplaceSource, blocked: MarketplaceSource): boolean {
  if (areSourcesEqual(source, blocked)) return true;
  if (source.source === "git" && blocked.source === "github") {
    const repo = extractGitHubRepoFromGitUrl(source.url);
    return repo === blocked.repo && optionalEq(source.ref, blocked.ref);
  }
  if (source.source === "github" && blocked.source === "git") {
    const repo = extractGitHubRepoFromGitUrl(blocked.url);
    return repo === source.repo && optionalEq(source.ref, blocked.ref);
  }
  return false;
}

function extractHostFromUrlOrSsh(value: string): string | null {
  const sshMatch = /^[^@]+@([^:]+):/u.exec(value);
  if (sshMatch?.[1]) return sshMatch[1];
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function extractGitHubRepoFromGitUrl(value: string): string | null {
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(value);
  if (sshMatch?.[1]) return sshMatch[1];
  const httpsMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(value);
  return httpsMatch?.[1] ?? null;
}

function optionalEq(left: string | undefined, right: string | undefined): boolean {
  return (left || undefined) === (right || undefined);
}

function getSettingsPattern(source: MarketplaceSource, prefix: string): string | null {
  if (source.source !== "settings" || !source.name.startsWith(prefix)) return null;
  return source.name.slice(prefix.length);
}

function matchesPolicyPattern(pattern: string, value: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_POLICY_PATTERN_LENGTH ||
    value.length > MAX_POLICY_PATTERN_VALUE_LENGTH
  ) {
    return false;
  }
  const compiled = compileSafePolicyPattern(pattern);
  if (compiled === null) return false;
  const starts = compiled.anchorStart ? [0] : [...Array(value.length + 1).keys()];
  return starts.some((start) => matchSafePolicyTokens(value, compiled.tokens, start, compiled.anchorEnd));
}

type PolicyPatternToken =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "any" }
  | { readonly type: "many" };

function compileSafePolicyPattern(pattern: string): {
  readonly anchorStart: boolean;
  readonly anchorEnd: boolean;
  readonly tokens: readonly PolicyPatternToken[];
} | null {
  const anchorStart = pattern.startsWith("^");
  const anchorEnd = hasTrailingAnchor(pattern);
  const end = anchorEnd ? pattern.length - 1 : pattern.length;
  const tokens: PolicyPatternToken[] = [];
  for (let index = anchorStart ? 1 : 0; index < end; index += 1) {
    const ch = pattern[index]!;
    if (ch === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || index + 1 >= end) return null;
      tokens.push({ type: "literal", value: escaped });
      index += 1;
      continue;
    }
    if (ch === "." && pattern[index + 1] === "*" && index + 1 < end) {
      tokens.push({ type: "many" });
      index += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: "any" });
      continue;
    }
    if ("+*?()[]{}|".includes(ch)) return null;
    tokens.push({ type: "literal", value: ch });
  }
  return { anchorStart, anchorEnd, tokens };
}

function hasTrailingAnchor(pattern: string): boolean {
  if (!pattern.endsWith("$")) return false;
  let escapes = 0;
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === "\\"; index -= 1) {
    escapes += 1;
  }
  return escapes % 2 === 0;
}

function matchSafePolicyTokens(
  value: string,
  tokens: readonly PolicyPatternToken[],
  start: number,
  anchorEnd: boolean,
): boolean {
  const memo = new Map<string, boolean>();
  const match = (valueIndex: number, tokenIndex: number): boolean => {
    const key = `${valueIndex}:${tokenIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    const token = tokens[tokenIndex];
    if (token === undefined) {
      result = anchorEnd ? valueIndex === value.length : valueIndex <= value.length;
    } else if (token.type === "many") {
      result = match(valueIndex, tokenIndex + 1) ||
        (valueIndex < value.length && match(valueIndex + 1, tokenIndex));
    } else if (valueIndex >= value.length) {
      result = false;
    } else if (token.type === "any") {
      result = match(valueIndex + 1, tokenIndex + 1);
    } else {
      result = value[valueIndex] === token.value && match(valueIndex + 1, tokenIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(start, 0);
}
