/**
 * Resolves AgenC LSP server configuration.
 *
 * The donor service resolves LSP servers from plugin manifests. AgenC does not
 * have that live plugin LSP surface in this tranche, so this module preserves
 * the config validation and resolution boundary with an injectable source.
 */

import type {
  LspServerConfig,
  LspServerConfigSource,
  ScopedLspServerConfig,
} from "./types.js";
import { errorMessage } from "../../utils/errors.js";
import { isRecord } from "../../utils/record.js";

export interface LspConfigParseFailure {
  readonly success: false;
  readonly reason: string;
}

export interface LspConfigParseSuccess {
  readonly success: true;
  readonly servers: Record<string, ScopedLspServerConfig>;
}

export type LspConfigParseResult =
  | LspConfigParseFailure
  | LspConfigParseSuccess;

let configuredSource: LspServerConfigSource = () => ({});

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function stringRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new Error(`${field}.${key} must be a string`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeExtensionMap(
  value: unknown,
): Readonly<Record<string, string>> {
  const raw = stringRecord(value, "extensionToLanguage");
  if (!raw || Object.keys(raw).length === 0) {
    throw new Error("extensionToLanguage must contain at least one extension");
  }
  const normalized: Record<string, string> = {};
  for (const [ext, language] of Object.entries(raw)) {
    const trimmedExt = ext.trim().toLowerCase();
    const key = trimmedExt.startsWith(".") ? trimmedExt : `.${trimmedExt}`;
    if (key.length <= 1) {
      throw new Error("extensionToLanguage contains an empty extension");
    }
    if (language.trim().length === 0) {
      throw new Error(`extensionToLanguage.${ext} must not be empty`);
    }
    // Store trimmed (mirroring the key) — this value is sent verbatim as the
    // LSP textDocument.languageId, which never carries surrounding whitespace.
    normalized[key] = language.trim();
  }
  return Object.freeze(normalized);
}

export function normalizeLspServerConfig(
  name: string,
  raw: unknown,
  scope?: string,
): ScopedLspServerConfig {
  if (!isRecord(raw)) {
    throw new Error(`LSP server ${name} must be an object`);
  }
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    throw new Error(`LSP server ${name} missing required command`);
  }
  if (raw.command !== raw.command.trim()) {
    throw new Error(`LSP server ${name} command must not include surrounding whitespace`);
  }
  if (raw.restartOnCrash !== undefined) {
    throw new Error(`LSP server ${name} restartOnCrash is not supported`);
  }
  if (raw.shutdownTimeout !== undefined) {
    throw new Error(`LSP server ${name} shutdownTimeout is not supported`);
  }
  if (
    typeof raw.workspaceFolder === "string" &&
    raw.workspaceFolder.trim().length > 0 &&
    raw.workspaceFolder !== raw.workspaceFolder.trim()
  ) {
    throw new Error(
      `LSP server ${name} workspaceFolder must not include surrounding whitespace`,
    );
  }
  const env = stringRecord(raw.env, "env");
  const config: LspServerConfig = Object.freeze({
    command: raw.command.trim(),
    args: Object.freeze([...stringArray(raw.args, "args")]),
    ...(env !== undefined ? { env } : {}),
    ...(typeof raw.workspaceFolder === "string" &&
    raw.workspaceFolder.trim().length > 0
      ? { workspaceFolder: raw.workspaceFolder.trim() }
      : {}),
    extensionToLanguage: normalizeExtensionMap(raw.extensionToLanguage),
    ...(raw.initializationOptions !== undefined
      ? { initializationOptions: raw.initializationOptions }
      : {}),
    ...(optionalPositiveInteger(raw.startupTimeout, "startupTimeout") !==
    undefined
      ? {
          startupTimeout: optionalPositiveInteger(
            raw.startupTimeout,
            "startupTimeout",
          )!,
        }
      : {}),
    ...(optionalPositiveInteger(raw.maxRestarts, "maxRestarts") !== undefined
      ? { maxRestarts: optionalPositiveInteger(raw.maxRestarts, "maxRestarts")! }
      : {}),
  });
  return Object.freeze({
    ...config,
    ...(scope !== undefined ? { scope, displayName: `${scope}:${name}` } : {}),
  });
}

export function parseLspServersConfig(raw: unknown): LspConfigParseResult {
  if (raw === undefined || raw === null) {
    return { success: true, servers: {} };
  }
  if (!isRecord(raw)) {
    return { success: false, reason: "lsp servers config must be an object" };
  }
  try {
    const servers: Record<string, ScopedLspServerConfig> = {};
    for (const [name, value] of Object.entries(raw)) {
      servers[name] = normalizeLspServerConfig(name, value);
    }
    return { success: true, servers };
  } catch (error) {
    return {
      success: false,
      reason: errorMessage(error),
    };
  }
}

export function setLspServerConfigSourceForTesting(
  source: LspServerConfigSource,
): () => void {
  const previous = configuredSource;
  configuredSource = source;
  return () => {
    configuredSource = previous;
  };
}

export function configureLspServerSource(source: LspServerConfigSource): void {
  configuredSource = source;
}

export async function getAllLspServers(
  source: LspServerConfigSource = configuredSource,
): Promise<{ readonly servers: Record<string, ScopedLspServerConfig> }> {
  return { servers: await source() };
}
