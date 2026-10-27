/**
 * Local Ollama's installed models for the `/providers` and `/model` menus.
 *
 * A local Ollama runs whatever tag its user pulled, so the bundled list (one
 * default model) says nothing about what is on this computer. The menus run in
 * the TUI process, so they ask the Ollama server the session would use
 * (`GET /api/tags`, no key) and keep the answer briefly: a pull or a delete
 * changes it.
 *
 * @module
 */

import { resolveProviderSettings } from "../config/resolve-provider.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../llm/registry/provider-info.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
} from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

export interface OllamaMenuModel {
  readonly model: string;
  /**
   * What the server reports the model can do. Newer Ollama servers list it in
   * `/api/tags`; older ones may leave it out, and the picker then shows no
   * capability tags for that model.
   */
  readonly capabilities?: readonly string[];
  /** Ollama's own size label, for example "20.9B". */
  readonly parameterSize?: string;
}

/** Shown under the list when the local Ollama server could not be read. */
export const OLLAMA_MODEL_LIST_UNAVAILABLE_NOTE =
  "Could not read the models on this Ollama server. Is it running?";

/** A pull or a delete changes the list, so an answer is reused only briefly. */
const LIST_REUSE_MS = 30_000;
/** The server is local: a slow answer means it is not there. */
const LIST_TIMEOUT_MS = 3_000;
const MAX_REMEMBERED_LISTS = 4;

const remembered = new Map<string, { readonly at: number; readonly models: readonly OllamaMenuModel[] }>();
const inFlight = new Map<string, Promise<readonly OllamaMenuModel[] | undefined>>();

/** The server the session would use: `OLLAMA_BASE_URL`, then config, then the default. */
function hostFor(ctx: SlashCommandContext): string {
  let environment: Readonly<Record<string, string | undefined>> = {};
  try {
    environment = providerEnvironmentFromCommandContext(ctx);
  } catch {
    // No captured provider environment: the configured or default host applies.
  }
  const config = readCommandConfig(ctx) ?? {};
  const baseURL = resolveProviderSettings("ollama", config, environment)?.baseURL ??
    BUILT_IN_PROVIDER_BASE_URLS.ollama;
  return baseURL.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
}

function fresh(host: string): readonly OllamaMenuModel[] | undefined {
  const entry = remembered.get(host);
  return entry !== undefined && Date.now() - entry.at < LIST_REUSE_MS ? entry.models : undefined;
}

/**
 * The models the menu last read from this context's Ollama server, while the
 * answer is fresh. Synchronous and offline: menus call it while they render;
 * `loadOllamaMenuModels` does the asking.
 */
export function readOllamaMenuModels(ctx: SlashCommandContext): readonly OllamaMenuModel[] | undefined {
  if (remembered.size === 0) return undefined;
  return fresh(hostFor(ctx));
}

/** What the last answer said a model can do, for the picker's tags. */
export function ollamaMenuModelCapabilities(model: string): readonly string[] | undefined {
  let newest: { readonly at: number; readonly capabilities?: readonly string[] } | undefined;
  for (const entry of remembered.values()) {
    const found = entry.models.find(candidate => candidate.model === model);
    if (found !== undefined && (newest === undefined || entry.at > newest.at)) {
      newest = { at: entry.at, ...(found.capabilities !== undefined ? { capabilities: found.capabilities } : {}) };
    }
  }
  return newest?.capabilities;
}

/** Ask the local Ollama server which models it has; undefined when it cannot be read. */
export async function loadOllamaMenuModels(
  ctx: SlashCommandContext,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly OllamaMenuModel[] | undefined> {
  const host = hostFor(ctx);
  const known = fresh(host);
  if (known !== undefined) return known;
  const pending = inFlight.get(host);
  if (pending !== undefined) return await pending;
  const request = listInstalledModels(host, options.fetchImpl ?? globalThis.fetch);
  inFlight.set(host, request);
  try {
    return await request;
  } finally {
    inFlight.delete(host);
  }
}

async function listInstalledModels(
  host: string,
  fetchImpl: typeof fetch,
): Promise<readonly OllamaMenuModel[] | undefined> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  }
  const models = parseOllamaTags(body);
  if (models === undefined) return undefined;
  remembered.delete(host);
  remembered.set(host, { at: Date.now(), models });
  while (remembered.size > MAX_REMEMBERED_LISTS) {
    remembered.delete(remembered.keys().next().value!);
  }
  return models;
}

/**
 * `/api/tags` as menu rows, sorted by name. A model the server says cannot
 * complete text (an embedding model) is left out; without a capabilities list
 * (older servers) every model is kept.
 */
export function parseOllamaTags(body: unknown): readonly OllamaMenuModel[] | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const list = (body as { models?: unknown }).models;
  if (!Array.isArray(list)) return undefined;
  const models: OllamaMenuModel[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { name?: unknown; model?: unknown; capabilities?: unknown; details?: unknown };
    const name = typeof row.name === "string" && row.name.trim().length > 0
      ? row.name.trim()
      : typeof row.model === "string" ? row.model.trim() : "";
    if (name.length === 0 || models.some(model => model.model === name)) continue;
    const capabilities = Array.isArray(row.capabilities)
      ? row.capabilities.filter((value): value is string => typeof value === "string")
      : undefined;
    if (capabilities !== undefined && capabilities.length > 0 && !capabilities.includes("completion")) continue;
    const details = row.details !== null && typeof row.details === "object"
      ? row.details as { parameter_size?: unknown } : undefined;
    models.push({
      model: name,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(typeof details?.parameter_size === "string" ? { parameterSize: details.parameter_size } : {}),
    });
  }
  return Object.freeze(models.sort((left, right) => left.model.localeCompare(right.model)));
}
