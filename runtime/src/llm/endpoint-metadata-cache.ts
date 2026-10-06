import { createHmac, randomBytes } from "node:crypto";
import { normalizeProviderMetadataIdentity } from "../provider-identity.js";
import type { LLMProvider } from "./types.js";

export type EndpointMetadataJson = object | string | number | boolean | null;
export interface EndpointMetadataScope {
  readonly provider: string;
  readonly identity: string;
}
interface Downloaded {
  readonly scope: EndpointMetadataScope;
  readonly json: string;
  readonly bytes: number;
  readonly expires: number;
}
interface Pending {
  readonly scope: EndpointMetadataScope;
  readonly result: Promise<string | undefined>;
}

// Only opaque, process-salted digests are retained as identities. Never export
// these keys to diagnostics or disk, even when a request fails.
const identitySecret = randomBytes(32);
function fingerprint(value: unknown): string {
  return createHmac("sha256", identitySecret).update(JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  })).digest("hex");
}

let refreshRevision = 0;
/** Explicit daemon refresh, including changes to policy behind a stable fetch. */
export function refreshEndpointMetadata(): void {
  refreshRevision += 1;
}

/**
 * Successful private endpoint JSON, shared only within one transport partition.
 * The TTL bounds reuse by later resolvers, not an active session's model limits.
 * Limits bound retained cache data; response.json() retains its existing parser
 * memory behavior. Saturation/oversize responses are usable but not retained.
 */
export class EndpointMetadataCache {
  readonly #now: () => number;
  readonly #reuseMs: number;
  readonly #maxEntries: number;
  readonly #maxEntryBytes: number;
  readonly #maxBytes: number;
  readonly #maxPending: number;
  readonly #scopes = new Map<string, EndpointMetadataScope>();
  readonly #downloaded = new Map<string, Downloaded>();
  readonly #pending = new Map<string, Pending>();
  #pendingCount = 0;
  #bytes = 0;
  #revision = 0;
  #refreshRevision = refreshRevision;

  constructor(options: {
    readonly now?: () => number;
    readonly reuseMs?: number;
    readonly maxEntries?: number;
    readonly maxEntryBytes?: number;
    readonly maxBytes?: number;
    readonly maxPending?: number;
  } = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#reuseMs = options.reuseMs ?? 10 * 60_000;
    this.#maxEntries = options.maxEntries ?? 128;
    this.#maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#maxPending = options.maxPending ?? 32;
    for (const limit of [this.#reuseMs, this.#maxEntries, this.#maxEntryBytes, this.#maxBytes, this.#maxPending]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid endpoint metadata cache limit");
    }
  }

  get revision(): number {
    if (this.#refreshRevision !== refreshRevision) {
      this.clear();
      this.#refreshRevision = refreshRevision;
    }
    return this.#revision;
  }

  clear(): void {
    this.#scopes.clear();
    this.#downloaded.clear();
    this.#pending.clear();
    this.#bytes = 0;
    this.#revision += 1;
  }

  /** Conservative rotation: simultaneous configurations of one provider evict
   * each other rather than leaving an old account available for A -> B -> A. */
  observe(provider: string, configuration: unknown): EndpointMetadataScope {
    void this.revision;
    const identity = fingerprint(configuration);
    const prior = this.#scopes.get(provider);
    if (prior?.identity === identity) return prior;
    if (prior !== undefined) this.invalidate(prior);
    if (this.#scopes.size >= this.#maxEntries) {
      this.invalidate(this.#scopes.values().next().value!);
    }
    const scope = Object.freeze({ provider, identity });
    this.#scopes.set(provider, scope);
    return scope;
  }

  /** Compare caller authority without rotating any other session's scope. */
  matchesConfiguration(scope: EndpointMetadataScope, configuration: unknown): boolean {
    return scope.identity === fingerprint(configuration);
  }

  invalidate(scope: EndpointMetadataScope): void {
    if (!this.#current(scope)) return;
    this.#scopes.delete(scope.provider);
    for (const [key, value] of this.#downloaded) {
      if (value.scope === scope) this.#remove(key);
    }
    for (const [key, value] of this.#pending) {
      if (value.scope === scope) this.#pending.delete(key);
    }
    this.#revision += 1;
  }

  /** Capture the generation at dispatch; a late old-account error cannot
   * invalidate a newly rotated account or a refreshed successful download. */
  failureHandler(provider: string): () => void {
    void this.revision;
    const scope = this.#scopes.get(provider);
    return () => { if (scope !== undefined) this.invalidate(scope); };
  }

  #current(scope: EndpointMetadataScope): boolean {
    void this.revision;
    return this.#scopes.get(scope.provider) === scope;
  }

  #remove(key: string): void {
    const old = this.#downloaded.get(key);
    if (old !== undefined) this.#bytes -= old.bytes;
    this.#downloaded.delete(key);
  }

  async get(
    scope: EndpointMetadataScope,
    request: {
      readonly baseUrl: string;
      readonly url: string;
      readonly method: string;
      readonly headers?: HeadersInit;
      readonly body?: string;
      readonly timeoutMs: number;
    },
    download: () => Promise<EndpointMetadataJson | undefined>,
  ): Promise<EndpointMetadataJson | undefined> {
    const current = this.#current(scope);
    const key = fingerprint([scope.provider, scope.identity, request.baseUrl,
      request.url, request.method, [...new Headers(request.headers)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      request.body ?? null, request.timeoutMs]);
    const now = this.#now();
    for (const [id, value] of this.#downloaded) {
      if (now >= value.expires) this.#remove(id);
    }
    const hit = this.#downloaded.get(key);
    if (current && hit?.scope === scope) {
      this.#downloaded.delete(key);
      this.#downloaded.set(key, hit);
      return JSON.parse(hit.json) as EndpointMetadataJson;
    }
    const pending = this.#pending.get(key);
    if (current && pending?.scope === scope) {
      const json = await pending.result;
      return json === undefined ? undefined : JSON.parse(json) as EndpointMetadataJson;
    }
    const retain = current && this.#pendingCount < this.#maxPending;
    const load = async (): Promise<string | undefined> => {
      try {
        const value = await download();
        if (value === undefined) {
          this.invalidate(scope);
          return undefined;
        }
        const json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json);
        // Invalidation revokes publication, not this caller's successful
        // response. Dropping it could replace a real lower limit with fallback.
        if (retain && this.#current(scope) && bytes <= this.#maxEntryBytes && bytes <= this.#maxBytes) {
          this.#remove(key);
          while (this.#downloaded.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes) {
            this.#remove(this.#downloaded.keys().next().value!);
          }
          this.#downloaded.set(key, { scope, json, bytes, expires: this.#now() + this.#reuseMs });
          this.#bytes += bytes;
        }
        return json;
      } catch {
        this.invalidate(scope);
        return undefined;
      }
    };
    // Defer download until its pending record has been published, including a
    // synchronously throwing downloader. Invalidated work cannot delete a new
    // record for the same key when it eventually finishes.
    const record: Pending = { scope, result: Promise.resolve().then(load) };
    if (retain) {
      this.#pendingCount += 1;
      this.#pending.set(key, record);
    }
    try {
      const json = await record.result;
      return json === undefined ? undefined : JSON.parse(json) as EndpointMetadataJson;
    } finally {
      if (retain) this.#pendingCount -= 1;
      if (this.#pending.get(key) === record) this.#pending.delete(key);
    }
  }
}

const transports = new WeakMap<typeof fetch, EndpointMetadataCache>();
/** Pass the underlying fetch, never a freshly bound wrapper. */
export function endpointMetadataForTransport(transport: typeof fetch): EndpointMetadataCache {
  let cache = transports.get(transport);
  if (cache === undefined) {
    cache = new EndpointMetadataCache();
    transports.set(transport, cache);
  }
  return cache;
}

/** Observed model errors invalidate the default network partition. Conservatively
 * evict the provider's current scope even when its model request used a custom
 * transport. No error, URL, credential or payload is retained. */
export function endpointMetadataFailureHandler(provider: string): () => void {
  return transports.get(globalThis.fetch)?.failureHandler(
    normalizeProviderMetadataIdentity(provider) ?? "",
  ) ?? (() => {});
}

/** Include SDK/stream-body failures as well as individual HTTP attempt errors. */
export function observeEndpointMetadataFailures<T extends LLMProvider>(provider: T, name: string): T {
  const chat = provider.chat;
  provider.chat = async function (...args) {
    const fail = endpointMetadataFailureHandler(name);
    try { return await chat.apply(this, args); }
    catch (error) { fail(); throw error; }
  };
  const chatStream = provider.chatStream;
  if (chatStream !== undefined) {
    provider.chatStream = async function (...args) {
      const fail = endpointMetadataFailureHandler(name);
      try { return await chatStream.apply(this, args); }
      catch (error) { fail(); throw error; }
    };
  }
  return provider;
}
