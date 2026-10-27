import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord } from "../../utils/record.js";
import { fetchProviderRequest } from "../credential-redirect-fetch.js";
import { OPENROUTER_MODELS, openRouterCatalogEntry, openRouterRowFromListing, type OpenRouterCatalogRow } from "./openrouter-models.js";
import { clearPublishedModelCatalog, publishedModelCatalogRevision, recordPublishedModelCatalog } from "./published-model-catalog.js";
import { recordPublishedModelCosts } from "./published-model-costs.js";
import { openRouterModelCosts } from "./openrouter-live-pricing.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_CATALOG_TTL_MS = 60 * 60_000;
export const OPENROUTER_CATALOG_FALLBACK_NOTE = "OpenRouter catalog unavailable; showing bundled models.";

export interface OpenRouterCatalogSnapshot {
  readonly source: "live" | "cache" | "bundled";
  readonly models: readonly OpenRouterCatalogRow[];
}

export interface OpenRouterCatalogOptions {
  /** Captured AgenC home. Omit for an in-memory resolver. */
  readonly home?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

function parseModels(body: unknown): readonly OpenRouterCatalogRow[] | undefined {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const rows = data.map(value => openRouterRowFromListing(value));
  // Never replace a good catalog with a partial or malformed response.
  if (rows.some(row => row === undefined)) return undefined;
  const models = rows as OpenRouterCatalogRow[];
  if (new Set(models.map(row => row.model)).size !== models.length) return undefined;
  return models;
}

let activeSnapshot: OpenRouterCatalogSnapshot | undefined;
let activeRevision = -1;

/** Disk reads are local; only refresh() touches the network. */
export class OpenRouterCatalog {
  readonly cachePath?: string;
  readonly #options: OpenRouterCatalogOptions;
  readonly #now: () => number;
  #at = 0;
  #snapshot: OpenRouterCatalogSnapshot = { source: "bundled", models: OPENROUTER_MODELS };
  #pending?: Promise<OpenRouterCatalogSnapshot>;
  #pricingMinute = -1;

  constructor(options: OpenRouterCatalogOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    if (options.home !== undefined) {
      const partition = createHash("sha256").update(options.apiKey ?? "public").digest("hex");
      this.cachePath = join(options.home, "cache", `openrouter-models-${partition}.json`);
      try {
        const cached = asRecord(JSON.parse(readFileSync(this.cachePath, "utf8")));
        const models = parseModels(cached?.body);
        if (cached?.version === 1 && typeof cached.at === "number" && Number.isFinite(cached.at) &&
            cached.at <= this.#now() && models !== undefined) {
          this.#at = cached.at;
          this.#snapshot = { source: "cache", models };
        }
      } catch {
        // Missing, corrupt or unreadable cache: use the bundled catalog.
      }
    }
  }

  read(): OpenRouterCatalogSnapshot {
    const pricingMinute = Math.floor(this.#now() / 60_000);
    if (activeSnapshot !== this.#snapshot || activeRevision !== publishedModelCatalogRevision() || this.#pricingMinute !== pricingMinute) {
      if (this.#snapshot.source === "bundled") clearPublishedModelCatalog("openrouter");
      else recordPublishedModelCatalog("openrouter", this.#snapshot.models.map(openRouterCatalogEntry), { replace: true });
      recordPublishedModelCosts("openrouter", this.#snapshot.source === "bundled"
        ? new Map() : openRouterModelCosts(this.#snapshot.models, this.#now()));
      this.#pricingMinute = pricingMinute;
      activeSnapshot = this.#snapshot;
      activeRevision = publishedModelCatalogRevision();
    }
    return this.#snapshot;
  }

  refresh(): Promise<OpenRouterCatalogSnapshot> {
    // Match other background network features: tests must inject a transport.
    // The hermetic runner sets NODE_ENV for workers and child processes.
    if (this.#options.fetchImpl === undefined && process.env.NODE_ENV === "test") {
      return Promise.resolve(this.read());
    }
    if (this.#pending !== undefined) return this.#pending;
    if (this.#snapshot.source !== "bundled" && this.#now() - this.#at < OPENROUTER_CATALOG_TTL_MS) {
      return Promise.resolve(this.read());
    }
    this.#pending = this.#download().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #download(): Promise<OpenRouterCatalogSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 5_000);
    timer.unref?.();
    try {
      const response = await fetchProviderRequest(OPENROUTER_MODELS_URL, {
        method: "GET",
        signal: controller.signal,
        ...(this.#options.apiKey ? { headers: { Authorization: `Bearer ${this.#options.apiKey}` } } : {}),
      }, this.#options.fetchImpl ?? globalThis.fetch);
      if (!response.ok) throw new Error("OpenRouter catalog request failed");
      const body: unknown = await response.json();
      const models = parseModels(body);
      if (models === undefined) throw new Error("Invalid OpenRouter catalog");
      this.#at = this.#now();
      this.#snapshot = { source: "live", models };
      if (this.cachePath !== undefined) {
        const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
          await writeFile(temporary, JSON.stringify({ version: 1, at: this.#at, body }), { mode: 0o600 });
          await rename(temporary, this.cachePath);
        } catch {
          // An unwritable cache must not discard a usable response.
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      }
    } catch {
      this.#snapshot = { source: "bundled", models: OPENROUTER_MODELS };
    } finally {
      clearTimeout(timer);
    }
    return this.read();
  }
}

const catalogs = new Map<string, OpenRouterCatalog>();

/** Share downloads for one home and credential, without retaining keys in cache files. */
export function openRouterCatalogFor(options: OpenRouterCatalogOptions): OpenRouterCatalog {
  const identity = createHash("sha256").update(JSON.stringify([options.home, options.apiKey])).digest("hex");
  let catalog = catalogs.get(identity);
  if (catalog === undefined) {
    catalog = new OpenRouterCatalog(options);
    if (catalogs.size >= 16) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(identity, catalog);
  }
  return catalog;
}
