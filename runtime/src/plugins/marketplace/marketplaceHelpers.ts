import {
  type Marketplace,
  type MarketplaceSource,
} from "./marketplace.js";

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
      return new RegExp(hostPattern).test(host);
    }
    const pathPattern = getSettingsPattern(allowed, "pathPattern:");
    if (pathPattern !== null) {
      const path = source.source === "file" || source.source === "directory" || source.source === "local"
        ? source.path
        : null;
      return path !== null && new RegExp(pathPattern).test(path);
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
