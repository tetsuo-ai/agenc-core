import { duplicateJsonObjectPaths } from "../../config/json.js";
import { isRecord } from "../../utils/record.js";
import {
  isReservedPluginStorageChildName,
  sanitizePluginId,
} from "../directories.js";
import { isCanonicalPluginName } from "../identifier.js";

export type MarketplacePluginInstallPolicy =
  | "NOT_AVAILABLE"
  | "AVAILABLE"
  | "INSTALLED_BY_DEFAULT";

export type MarketplacePluginAuthPolicy = "ON_INSTALL" | "ON_USE";

export interface RawMarketplaceManifest {
  readonly name?: string;
  readonly metadata?: {
    readonly name?: string;
    readonly displayName?: string;
  };
  readonly interface?: {
    readonly displayName?: string;
  };
  readonly plugins: readonly RawMarketplaceManifestPlugin[];
}

export interface RawMarketplaceManifestPlugin {
  readonly name: string;
  readonly source: MarketplaceCatalogPluginSource;
  readonly policy?: {
    readonly installation?: MarketplacePluginInstallPolicy;
    readonly authentication?: MarketplacePluginAuthPolicy;
    readonly products?: readonly string[];
  };
  readonly category?: string;
}

export type MarketplaceCatalogPluginSource =
  | string
  | { readonly source: "local"; readonly path: string }
  | {
      readonly source: "url" | "git";
      readonly url: string;
      readonly path?: string;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly source: "git-subdir";
      readonly url: string;
      readonly path: string;
      readonly ref?: string;
      readonly sha?: string;
    };

export interface MarketplaceManifestIssue {
  readonly path: string;
  readonly message: string;
}

export class MarketplaceManifestError extends Error {
  constructor(readonly issues: readonly MarketplaceManifestIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "MarketplaceManifestError";
  }
}

/** Parse and normalize the one supported marketplace catalog format. */
export function parseMarketplaceManifestText(
  content: string,
): RawMarketplaceManifest {
  const duplicatePaths = duplicateJsonObjectPaths(content);
  if (duplicatePaths.length > 0) {
    throw new MarketplaceManifestError([{
      path: "json",
      message:
        `Marketplace manifest contains duplicate object keys: ${duplicatePaths.join(", ")}`,
    }]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new MarketplaceManifestError([{
      path: "json",
      message:
        `Invalid JSON syntax: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  return normalizeMarketplaceManifest(parsed);
}

export function normalizeMarketplaceManifest(
  value: unknown,
): RawMarketplaceManifest {
  if (!isRecord(value) || !Array.isArray(value.plugins)) {
    throw new MarketplaceManifestError([{
      path: "plugins",
      message: "Marketplace must define a plugins array",
    }]);
  }

  const issues: MarketplaceManifestIssue[] = [];
  const plugins: RawMarketplaceManifestPlugin[] = [];
  const names = new Map<string, string>();
  const storageNames = new Map<string, string>();
  for (const [index, entry] of value.plugins.entries()) {
    const plugin = normalizeMarketplacePlugin(entry, index, issues);
    if (plugin === undefined) continue;
    validateMarketplacePluginUniqueness(
      plugin.name,
      index,
      names,
      storageNames,
      issues,
    );
    plugins.push(plugin);
  }

  if (issues.length > 0) {
    throw new MarketplaceManifestError(issues);
  }

  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(isRecord(value.metadata)
      ? {
          metadata: {
            ...(typeof value.metadata.name === "string"
              ? { name: value.metadata.name }
              : {}),
            ...(typeof value.metadata.displayName === "string"
              ? { displayName: value.metadata.displayName }
              : {}),
          },
        }
      : {}),
    ...(isRecord(value.interface)
      ? {
          interface: {
            ...(typeof value.interface.displayName === "string"
              ? { displayName: value.interface.displayName }
              : {}),
          },
        }
      : {}),
    plugins,
  };
}

function normalizeMarketplacePlugin(
  entry: unknown,
  index: number,
  issues: MarketplaceManifestIssue[],
): RawMarketplaceManifestPlugin | undefined {
  const basePath = `plugins[${index}]`;
  if (!isRecord(entry)) {
    issues.push({
      path: basePath,
      message: "Marketplace plugin entry must be an object",
    });
    return undefined;
  }
  if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
    issues.push({
      path: `${basePath}.name`,
      message: "Marketplace plugin entry must define a non-empty name",
    });
    return undefined;
  }

  const name = entry.name.trim();
  if (isReservedPluginStorageChildName(name)) {
    issues.push({
      path: `${basePath}.name`,
      message: `Plugin name "${entry.name}" is reserved for plugin storage`,
    });
  } else if (entry.name !== name || !isCanonicalPluginName(name)) {
    issues.push({
      path: `${basePath}.name`,
      message:
        "Marketplace plugin name must be a lowercase canonical identifier using letters, digits, '.', '_', or '-'",
    });
  }

  if (!("source" in entry)) {
    issues.push({
      path: `${basePath}.source`,
      message: `Marketplace plugin '${entry.name}' must define source`,
    });
    return undefined;
  }
  const source = normalizeMarketplacePluginSource(
    entry.source,
    `${basePath}.source`,
    issues,
  );

  const policy = isRecord(entry.policy)
    ? normalizeMarketplacePluginPolicy(entry.name, entry.policy, basePath, issues)
    : undefined;
  if (source === undefined) return undefined;
  return {
    name,
    source,
    ...(policy !== undefined ? { policy } : {}),
    ...(typeof entry.category === "string" ? { category: entry.category } : {}),
  };
}

function normalizeMarketplacePluginSource(
  source: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplaceCatalogPluginSource | undefined {
  if (typeof source === "string") {
    validateLocalSourcePath(source, path, issues);
    return source;
  }
  if (!isRecord(source)) {
    issues.push({
      path,
      message: "Marketplace plugin source must be a local path or source object",
    });
    return undefined;
  }
  if (typeof source.source !== "string") {
    issues.push({
      path: `${path}.source`,
      message: "Marketplace plugin source object must define a supported source type",
    });
    return undefined;
  }

  switch (source.source) {
    case "local": {
      const localPath = requiredSourceString(source, "path", path, issues);
      rejectUnexpectedSourceKeys(source, ["source", "path"], path, issues);
      if (localPath === undefined) return undefined;
      validateLocalSourcePath(localPath, path, issues);
      return { source: "local", path: localPath };
    }
    case "url":
    case "git": {
      const url = requiredSourceString(source, "url", path, issues);
      const subdir = optionalSourceString(source, "path", path, issues);
      const ref = optionalSourceString(source, "ref", path, issues);
      const sha = optionalSourceSha(source, path, issues);
      rejectUnexpectedSourceKeys(
        source,
        ["source", "url", "path", "ref", "sha"],
        path,
        issues,
      );
      if (subdir !== undefined) validateGitSourcePath(subdir, path, issues);
      if (url === undefined) return undefined;
      return {
        source: source.source,
        url,
        ...(subdir !== undefined ? { path: subdir } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    case "git-subdir": {
      const url = requiredSourceString(source, "url", path, issues);
      const subdir = requiredSourceString(source, "path", path, issues);
      const ref = optionalSourceString(source, "ref", path, issues);
      const sha = optionalSourceSha(source, path, issues);
      rejectUnexpectedSourceKeys(
        source,
        ["source", "url", "path", "ref", "sha"],
        path,
        issues,
      );
      if (subdir !== undefined) validateGitSourcePath(subdir, path, issues);
      if (url === undefined || subdir === undefined) return undefined;
      return {
        source: "git-subdir",
        url,
        path: subdir,
        ...(ref !== undefined ? { ref } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    default:
      issues.push({
        path: `${path}.source`,
        message: `Unsupported marketplace plugin source type '${source.source}'`,
      });
      return undefined;
  }
}

function validateLocalSourcePath(
  localPath: string,
  path: string,
  issues: MarketplaceManifestIssue[],
): void {
  const stripped = localPath.startsWith("./") ? localPath.slice(2) : "";
  const parts = stripped.split(/[\\/]+/u);
  if (
    stripped.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    issues.push({
      path,
      message:
        "Local marketplace plugin source must start with './' and must stay within the marketplace root",
    });
  }
}

function validateGitSourcePath(
  subdir: string,
  path: string,
  issues: MarketplaceManifestIssue[],
): void {
  const stripped = subdir.startsWith("./") ? subdir.slice(2) : subdir;
  const parts = stripped.split(/[\\/]+/u);
  if (
    stripped.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    issues.push({
      path: `${path}.path`,
      message: "Git marketplace plugin source path must stay within the repository root",
    });
  }
}

function requiredSourceString(
  source: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
  issues: MarketplaceManifestIssue[],
): string | undefined {
  const value = source[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    issues.push({
      path: `${path}.${field}`,
      message:
        `Marketplace plugin source '${source.source}' must include a non-empty string ${field}`,
    });
    return undefined;
  }
  return value;
}

function optionalSourceString(
  source: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
  issues: MarketplaceManifestIssue[],
): string | undefined {
  if (source[field] === undefined) return undefined;
  return requiredSourceString(source, field, path, issues);
}

function optionalSourceSha(
  source: Readonly<Record<string, unknown>>,
  path: string,
  issues: MarketplaceManifestIssue[],
): string | undefined {
  const sha = optionalSourceString(source, "sha", path, issues);
  if (
    sha !== undefined &&
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(sha)
  ) {
    issues.push({
      path: `${path}.sha`,
      message: "Marketplace plugin source SHA must be a full hexadecimal commit ID",
    });
  }
  return sha;
}

function rejectUnexpectedSourceKeys(
  source: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  issues: MarketplaceManifestIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (allowedKeys.has(key)) continue;
    issues.push({
      path: `${path}.${key}`,
      message: `Marketplace plugin source '${source.source}' does not support '${key}'`,
    });
  }
}

function normalizeMarketplacePluginPolicy(
  pluginName: string,
  policy: Readonly<Record<string, unknown>>,
  basePath: string,
  issues: MarketplaceManifestIssue[],
): RawMarketplaceManifestPlugin["policy"] {
  if (
    policy.installation !== undefined &&
    policy.installation !== "NOT_AVAILABLE" &&
    policy.installation !== "AVAILABLE" &&
    policy.installation !== "INSTALLED_BY_DEFAULT"
  ) {
    issues.push({
      path: `${basePath}.policy.installation`,
      message:
        `Marketplace plugin '${pluginName}' has invalid installation policy`,
    });
  }
  if (
    policy.authentication !== undefined &&
    policy.authentication !== "ON_INSTALL" &&
    policy.authentication !== "ON_USE"
  ) {
    issues.push({
      path: `${basePath}.policy.authentication`,
      message:
        `Marketplace plugin '${pluginName}' has invalid authentication policy`,
    });
  }
  if (
    policy.products !== undefined &&
    (!Array.isArray(policy.products) ||
      !policy.products.every((value) => typeof value === "string"))
  ) {
    issues.push({
      path: `${basePath}.policy.products`,
      message:
        `Marketplace plugin '${pluginName}' products policy must be an array of strings`,
    });
  }
  return {
    ...(policy.installation === "NOT_AVAILABLE" ||
      policy.installation === "AVAILABLE" ||
      policy.installation === "INSTALLED_BY_DEFAULT"
      ? { installation: policy.installation }
      : {}),
    ...(policy.authentication === "ON_INSTALL" ||
      policy.authentication === "ON_USE"
      ? { authentication: policy.authentication }
      : {}),
    ...(Array.isArray(policy.products) &&
      policy.products.every((value): value is string => typeof value === "string")
      ? { products: policy.products }
      : {}),
  };
}

function validateMarketplacePluginUniqueness(
  name: string,
  index: number,
  names: Map<string, string>,
  storageNames: Map<string, string>,
  issues: MarketplaceManifestIssue[],
): void {
  const identity = name.toLowerCase();
  const existingName = names.get(identity);
  if (existingName !== undefined) {
    issues.push({
      path: `plugins[${index}].name`,
      message:
        `Marketplace manifest has duplicate plugin names: '${existingName}' and '${name}'`,
    });
    return;
  }
  names.set(identity, name);

  const storageName = sanitizePluginId(name).toLowerCase();
  const existingStorageName = storageNames.get(storageName);
  if (existingStorageName !== undefined) {
    issues.push({
      path: `plugins[${index}].name`,
      message:
        `Marketplace plugin names '${existingStorageName}' and '${name}' resolve to the same canonical storage name`,
    });
    return;
  }
  storageNames.set(storageName, name);
}
