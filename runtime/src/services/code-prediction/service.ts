import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import ignore, { type Ignore } from "ignore";
import { LRUCache } from "lru-cache";

import type { BufferPredictionConfig } from "../../config/schema.js";
import type { LLMProvider, LLMUsage } from "../../llm/types.js";
import {
  buildCodePredictionMessages,
  compilePredictionIgnore,
  isCodePredictionRelatedBufferAllowed,
  isPathInsideWorkspace,
  normalizePredictionText,
  prepareCodePredictionContext,
  utf8ByteLength,
  type PreparedCodePredictionContext,
  type PredictionIgnoreMatcher,
} from "./context.js";
import { createOwnedCodePredictionProvider } from "./provider.js";
import type {
  CodePredictionFeedback,
  CodePredictionMetric,
  CodePredictionRequest,
  CodePredictionResult,
  CodePredictionSource,
  CodePredictionSourceResolver,
  OwnedCodePredictionProvider,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const MAX_SESSION_CONCURRENCY = 2;
const ADMISSION_TIMEOUT_MS = 100;
const CACHE_MAX_ENTRIES = 128;
const CACHE_TTL_MS = 2 * 60 * 1_000;
const TOKEN_BUCKET_CAPACITY = 3;
const TOKEN_BUCKET_REFILL_PER_MS = 30 / 60_000;
const MAX_PREDICTION_OUTPUT_BYTES = 64 * 1024;
const PREDICTION_CONFIG_KEYS = [
  "enabled",
  "debounce_ms",
  "timeout_ms",
  "max_output_tokens",
  "provider",
  "model",
] as const satisfies readonly (keyof BufferPredictionConfig)[];

function predictionConfigEqual(
  left: BufferPredictionConfig,
  right: BufferPredictionConfig,
): boolean {
  return PREDICTION_CONFIG_KEYS.every((key) => left[key] === right[key]);
}

interface ActivePrediction {
  readonly requestId: string;
  readonly generation: number;
  readonly controller: AbortController;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

interface CachedPrediction {
  readonly sessionId: string;
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}

interface PendingProviderSelection {
  readonly sessionId: string;
  readonly routeEpoch: symbol;
  readonly promise: Promise<OwnedCodePredictionProvider | null>;
}

interface AdmissionWaiter {
  readonly resolve: (release: (() => void) | null) => void;
  readonly signal: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface GitIgnoreLayer {
  readonly base: string;
  readonly matcher: Ignore;
}

class SessionPredictionAdmission {
  readonly #active = new Map<string, number>();
  readonly #waiters = new Map<string, AdmissionWaiter[]>();

  async acquire(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<(() => void) | null> {
    if (signal.aborted) return null;
    if ((this.#active.get(sessionId) ?? 0) < MAX_SESSION_CONCURRENCY) {
      return this.#grant(sessionId);
    }
    return await new Promise<(() => void) | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#removeWaiter(sessionId, waiter);
        resolve(null);
      }, ADMISSION_TIMEOUT_MS);
      timer.unref?.();
      const waiter: AdmissionWaiter = { resolve, signal, timer };
      const queue = this.#waiters.get(sessionId) ?? [];
      queue.push(waiter);
      this.#waiters.set(sessionId, queue);
      signal.addEventListener(
        "abort",
        () => {
          if (!this.#removeWaiter(sessionId, waiter)) return;
          clearTimeout(timer);
          resolve(null);
        },
        { once: true },
      );
    });
  }

  disposeSession(sessionId: string): void {
    const queue = this.#waiters.get(sessionId);
    this.#waiters.delete(sessionId);
    for (const waiter of queue ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  dispose(): void {
    for (const sessionId of this.#waiters.keys()) {
      this.disposeSession(sessionId);
    }
    this.#active.clear();
  }

  #grant(sessionId: string): () => void {
    this.#active.set(sessionId, (this.#active.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, (this.#active.get(sessionId) ?? 1) - 1);
      if (nextCount === 0) this.#active.delete(sessionId);
      else this.#active.set(sessionId, nextCount);
      this.#drain(sessionId);
    };
  }

  #removeWaiter(sessionId: string, target: AdmissionWaiter): boolean {
    const queue = this.#waiters.get(sessionId);
    if (queue === undefined) return false;
    const index = queue.indexOf(target);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.#waiters.delete(sessionId);
    return true;
  }

  #drain(sessionId: string): void {
    const queue = this.#waiters.get(sessionId);
    while (
      queue !== undefined &&
      queue.length > 0 &&
      (this.#active.get(sessionId) ?? 0) < MAX_SESSION_CONCURRENCY
    ) {
      const waiter = queue.shift()!;
      clearTimeout(waiter.timer);
      if (waiter.signal.aborted) {
        waiter.resolve(null);
        continue;
      }
      waiter.resolve(this.#grant(sessionId));
    }
    if (queue?.length === 0) this.#waiters.delete(sessionId);
  }
}

export interface CodePredictionServiceOptions {
  readonly resolveSource: CodePredictionSourceResolver;
  readonly config?: BufferPredictionConfig;
  readonly now?: () => number;
  readonly emitMetric?: (metric: CodePredictionMetric) => void;
  readonly readIgnoreFile?: (path: string) => Promise<string | undefined>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly createProvider?: typeof createOwnedCodePredictionProvider;
}

/**
 * Transcript-free, independently-owned provider path for embedded-editor
 * predictions. No conversation, tool registry, fallback ladder, or retry path
 * is shared with the primary Agent turn.
 */
export class CodePredictionService {
  readonly #resolveSource: CodePredictionSourceResolver;
  #config: BufferPredictionConfig;
  readonly #now: () => number;
  readonly #emitMetric: ((metric: CodePredictionMetric) => void) | undefined;
  readonly #readIgnoreFile: (path: string) => Promise<string | undefined>;
  readonly #realpath: (path: string) => Promise<string>;
  readonly #createProvider: typeof createOwnedCodePredictionProvider;
  readonly #activeByEditor = new Map<string, ActivePrediction>();
  readonly #providers = new Map<string, OwnedCodePredictionProvider>();
  readonly #providerSelections = new Map<string, PendingProviderSelection>();
  readonly #providerSourceIds = new WeakMap<LLMProvider, number>();
  readonly #providerSourceIdsBySession = new Map<string, number>();
  readonly #routeEpochsBySession = new Map<string, symbol>();
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #admission = new SessionPredictionAdmission();
  readonly #cache = new LRUCache<string, CachedPrediction>({
    max: CACHE_MAX_ENTRIES,
    ttl: CACHE_TTL_MS,
  });
  /**
   * Ignore files are a privacy boundary, so an atomic replace must not create
   * a brief fail-open prediction window. Once observed, the last valid rules
   * remain active until a later successful read replaces them (or the service
   * is disposed).
   */
  readonly #lastKnownIgnoreFiles = new Map<string, string>();
  #configRevision = 0;
  #nextProviderSourceId = 1;
  #disposed = false;

  constructor(options: CodePredictionServiceOptions) {
    this.#resolveSource = options.resolveSource;
    this.#config = { ...(options.config ?? {}) };
    this.#now = options.now ?? (() => Date.now());
    this.#emitMetric = options.emitMetric;
    this.#readIgnoreFile =
      options.readIgnoreFile ??
      (async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      });
    this.#createProvider =
      options.createProvider ?? createOwnedCodePredictionProvider;
    this.#realpath = options.realpath ?? realpath;
  }

  async updateConfig(
    config: BufferPredictionConfig | undefined,
  ): Promise<void> {
    const next = { ...(config ?? {}) };
    // File watching and an explicit daemon.reload can observe the same
    // durable consent write. An equivalent second reload must be a no-op:
    // aborting here would cancel the first post-consent prediction after its
    // provider request was already dispatched.
    if (predictionConfigEqual(this.#config, next)) return;
    this.#config = next;
    this.#configRevision += 1;
    for (const active of this.#activeByEditor.values()) {
      active.controller.abort(new Error("prediction configuration changed"));
    }
    this.#activeByEditor.clear();
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    this.#providerSelections.clear();
    this.#cache.clear();
    this.#buckets.clear();
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
  }

  async complete(
    request: CodePredictionRequest,
    signal?: AbortSignal,
  ): Promise<CodePredictionResult> {
    const startedAt = this.#now();
    this.#assertRequest(request);
    const config = this.#config;
    const configRevision = this.#configRevision;
    if (this.#disposed || config.enabled === "off") {
      return this.#suppressed(request, "disabled", startedAt);
    }
    if ((config.enabled ?? "ask") === "ask") {
      return this.#suppressed(request, "consent_required", startedAt);
    }
    const editorKey = `${request.sessionId}\0${request.editorInstanceId}`;
    const previous = this.#activeByEditor.get(editorKey);
    if (previous !== undefined) {
      previous.controller.abort(new Error("superseded by newer prediction"));
    }
    const controller = new AbortController();
    const active: ActivePrediction = {
      requestId: request.requestId,
      generation: request.generation,
      controller,
    };
    this.#activeByEditor.set(editorKey, active);
    const abortFromCaller = (): void => {
      controller.abort(
        signal?.reason ?? new Error("prediction request cancelled"),
      );
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      if (controller.signal.aborted) {
        return this.#suppressed(request, "cancelled", startedAt);
      }
      if (!this.#takeToken(editorKey)) {
        return this.#suppressed(request, "rate_limited", startedAt);
      }
      const source = await this.#resolveSource(request.sessionId);
      if (!this.#isCurrent(editorKey, active)) {
        return this.#suppressed(request, "stale", startedAt);
      }
      const routeEpoch = await this.#synchronizeSessionRoute(
        request.sessionId,
        source.provider,
        active,
      );
      if (
        routeEpoch === null ||
        configRevision !== this.#configRevision ||
        !this.#isCurrent(editorKey, active)
      ) {
        return this.#suppressed(request, "stale", startedAt);
      }
      // Apply every privacy rail to the user-visible lexical identity before
      // resolving symlinks. Otherwise an ignored or sensitive alias could shed
      // its protected name when replaced with an innocuous canonical target.
      const lexicalIgnored = await this.#loadIgnore(source, request);
      if (
        configRevision !== this.#configRevision ||
        !this.#isCurrent(editorKey, active)
      ) {
        return this.#suppressed(request, "stale", startedAt);
      }
      const lexicalPrepared = prepareCodePredictionContext({
        request,
        workspaceRoot: source.workspaceRoot,
        ...(lexicalIgnored !== undefined ? { ignored: lexicalIgnored } : {}),
      });
      if ("reason" in lexicalPrepared) {
        return this.#suppressed(request, lexicalPrepared.reason, startedAt);
      }
      const lexicallySafeRequest =
        request.relatedBuffers === undefined
          ? request
          : {
              ...request,
              relatedBuffers: request.relatedBuffers.filter((buffer) =>
                isCodePredictionRelatedBufferAllowed({
                  buffer,
                  workspaceRoot: source.workspaceRoot,
                  ...(lexicalIgnored !== undefined
                    ? { ignored: lexicalIgnored }
                    : {}),
                }),
              ),
            };
      const canonical = await this.#canonicalizeRequest(
        source,
        lexicallySafeRequest,
      );
      if (canonical === null) {
        return this.#suppressed(request, "outside_workspace", startedAt);
      }
      const ignored = await this.#loadIgnore(
        canonical.source,
        canonical.request,
      );
      if (
        configRevision !== this.#configRevision ||
        !this.#isCurrent(editorKey, active)
      ) {
        return this.#suppressed(request, "stale", startedAt);
      }
      const prepared = prepareCodePredictionContext({
        request: canonical.request,
        workspaceRoot: canonical.source.workspaceRoot,
        ...(ignored !== undefined ? { ignored } : {}),
      });
      if ("reason" in prepared) {
        return this.#suppressed(request, prepared.reason, startedAt);
      }
      const route = await this.#providerFor(
        canonical.source,
        request.sessionId,
        config,
        configRevision,
        routeEpoch,
      );
      if (route === null) {
        return this.#suppressed(request, "stale", startedAt);
      }
      const cacheKey = this.#cacheKey(
        `${request.sessionId}\0${route.routeKey}`,
        prepared.context,
      );
      const cached = this.#cache.get(cacheKey);
      if (cached !== undefined) {
        if (!this.#isCurrent(editorKey, active)) {
          return this.#suppressed(request, "stale", startedAt);
        }
        const result = {
          status: "completed",
          requestId: request.requestId,
          generation: request.generation,
          changedtick: request.changedtick,
          text: cached.text,
          provider: cached.provider,
          model: cached.model,
          latencyMs: Math.max(0, this.#now() - startedAt),
          cached: true,
        } as const;
        this.#metric(request.sessionId, "cached", result.latencyMs);
        return result;
      }
      const release = await this.#admission.acquire(
        request.sessionId,
        controller.signal,
      );
      if (release === null) {
        return this.#suppressed(
          request,
          controller.signal.aborted ? "cancelled" : "admission_timeout",
          startedAt,
        );
      }
      try {
        const completion = await this.#predict(
          route,
          prepared.context,
          controller.signal,
          config,
        );
        if (!this.#isCurrent(editorKey, active)) {
          return this.#suppressed(request, "stale", startedAt);
        }
        const text = normalizePredictionText(completion.text);
        if (text.length === 0) {
          return this.#suppressed(request, "empty", startedAt);
        }
        if (utf8ByteLength(text) > MAX_PREDICTION_OUTPUT_BYTES) {
          return this.#suppressed(request, "output_too_large", startedAt);
        }
        this.#cache.set(cacheKey, {
          sessionId: request.sessionId,
          text,
          provider: route.providerName,
          model: completion.model || route.model,
        });
        const result = {
          status: "completed",
          requestId: request.requestId,
          generation: request.generation,
          changedtick: request.changedtick,
          text,
          provider: route.providerName,
          model: completion.model || route.model,
          latencyMs: Math.max(0, this.#now() - startedAt),
          cached: false,
          ...(completion.usage !== undefined
            ? { usage: completion.usage }
            : {}),
        } as const;
        this.#metric(request.sessionId, "completed", result.latencyMs);
        return result;
      } finally {
        release();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return this.#suppressed(request, "cancelled", startedAt);
      }
      this.#metric(
        request.sessionId,
        "error",
        Math.max(0, this.#now() - startedAt),
      );
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.#activeByEditor.get(editorKey) === active) {
        this.#activeByEditor.delete(editorKey);
      }
    }
  }

  cancel(params: {
    readonly sessionId: string;
    readonly editorInstanceId: string;
    readonly requestId?: string;
  }): boolean {
    const editorKey = `${params.sessionId}\0${params.editorInstanceId}`;
    const active = this.#activeByEditor.get(editorKey);
    if (
      active === undefined ||
      (params.requestId !== undefined && params.requestId !== active.requestId)
    ) {
      return false;
    }
    active.controller.abort(new Error("prediction cancelled"));
    this.#activeByEditor.delete(editorKey);
    return true;
  }

  feedback(feedback: CodePredictionFeedback): void {
    this.#emitMetric?.({
      type: "feedback",
      sessionId: feedback.sessionId,
      kind: feedback.kind,
      ...(feedback.acceptedCharacters !== undefined
        ? { acceptedCharacters: feedback.acceptedCharacters }
        : {}),
      ...(feedback.latencyMs !== undefined
        ? { latencyMs: feedback.latencyMs }
        : {}),
    });
  }

  async disposeSession(sessionId: string): Promise<void> {
    const providers = this.#releaseSessionResources(sessionId);
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#configRevision += 1;
    for (const active of this.#activeByEditor.values()) {
      active.controller.abort(new Error("prediction service disposed"));
    }
    this.#activeByEditor.clear();
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    this.#providerSelections.clear();
    this.#providerSourceIdsBySession.clear();
    this.#routeEpochsBySession.clear();
    this.#buckets.clear();
    this.#admission.dispose();
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
    this.#cache.clear();
    this.#lastKnownIgnoreFiles.clear();
  }

  async #providerFor(
    source: CodePredictionSource,
    sessionId: string,
    config: BufferPredictionConfig,
    configRevision: number,
    routeEpoch: symbol,
  ): Promise<OwnedCodePredictionProvider | null> {
    if (this.#routeEpochsBySession.get(sessionId) !== routeEpoch) return null;
    const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxOutputTokens =
      config.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const selectionKey = [
      configRevision,
      sessionId,
      source.workspaceRoot,
      this.#providerSourceId(source.provider),
      config.provider ?? "",
      config.model ?? "",
      timeoutMs,
      maxOutputTokens,
    ].join("\0");
    const existingSelection = this.#providerSelections.get(selectionKey);
    if (
      existingSelection !== undefined &&
      existingSelection.routeEpoch === routeEpoch
    ) {
      return await existingSelection.promise;
    }
    const promise = this.#createProviderSelection({
      source,
      sessionId,
      config,
      configRevision,
      routeEpoch,
      timeoutMs,
      maxOutputTokens,
    });
    const pending: PendingProviderSelection = {
      sessionId,
      routeEpoch,
      promise,
    };
    this.#providerSelections.set(selectionKey, pending);
    try {
      const selected = await promise;
      if (
        selected === null &&
        this.#providerSelections.get(selectionKey) === pending
      ) {
        this.#providerSelections.delete(selectionKey);
      }
      return selected;
    } catch (error) {
      if (this.#providerSelections.get(selectionKey) === pending) {
        this.#providerSelections.delete(selectionKey);
      }
      throw error;
    }
  }

  async #createProviderSelection(params: {
    readonly source: CodePredictionSource;
    readonly sessionId: string;
    readonly config: BufferPredictionConfig;
    readonly configRevision: number;
    readonly routeEpoch: symbol;
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
  }): Promise<OwnedCodePredictionProvider | null> {
    const candidate = await this.#createProvider({
      source: params.source,
      provider: params.config.provider,
      model: params.config.model,
      timeoutMs: params.timeoutMs,
      maxOutputTokens: params.maxOutputTokens,
    });
    if (
      this.#disposed ||
      params.configRevision !== this.#configRevision ||
      this.#routeEpochsBySession.get(params.sessionId) !== params.routeEpoch
    ) {
      await candidate.dispose();
      return null;
    }
    const ownedRouteKey = `${params.sessionId}\0${candidate.routeKey}`;
    const existing = this.#providers.get(ownedRouteKey);
    if (existing !== undefined) {
      await candidate.dispose();
      return existing;
    }
    this.#providers.set(ownedRouteKey, candidate);
    return candidate;
  }

  async #synchronizeSessionRoute(
    sessionId: string,
    provider: LLMProvider,
    currentPrediction: ActivePrediction,
  ): Promise<symbol | null> {
    if (this.#disposed) return null;
    const sourceId = this.#providerSourceId(provider);
    const previousSourceId = this.#providerSourceIdsBySession.get(sessionId);
    const existingEpoch = this.#routeEpochsBySession.get(sessionId);
    if (previousSourceId === sourceId && existingEpoch !== undefined) {
      return existingEpoch;
    }

    const routeEpoch = Symbol(sessionId);
    this.#providerSourceIdsBySession.set(sessionId, sourceId);
    this.#routeEpochsBySession.set(sessionId, routeEpoch);
    if (previousSourceId === undefined) return routeEpoch;

    const providers = this.#releaseSessionResources(sessionId, {
      preserveActive: currentPrediction,
      preserveSource: true,
      nextRouteEpoch: routeEpoch,
    });
    await Promise.allSettled(providers.map((owned) => owned.dispose()));
    return !this.#disposed &&
      this.#routeEpochsBySession.get(sessionId) === routeEpoch
      ? routeEpoch
      : null;
  }

  #releaseSessionResources(
    sessionId: string,
    options: {
      readonly preserveActive?: ActivePrediction;
      readonly preserveSource?: boolean;
      readonly nextRouteEpoch?: symbol;
    } = {},
  ): OwnedCodePredictionProvider[] {
    const prefix = `${sessionId}\0`;
    for (const [editorKey, active] of this.#activeByEditor) {
      if (!editorKey.startsWith(prefix) || active === options.preserveActive) {
        continue;
      }
      active.controller.abort(new Error("prediction session route disposed"));
      this.#activeByEditor.delete(editorKey);
    }
    for (const [selectionKey, selection] of this.#providerSelections) {
      if (selection.sessionId === sessionId) {
        this.#providerSelections.delete(selectionKey);
      }
    }
    const providers: OwnedCodePredictionProvider[] = [];
    for (const [ownedRouteKey, provider] of this.#providers) {
      if (!ownedRouteKey.startsWith(prefix)) continue;
      this.#providers.delete(ownedRouteKey);
      providers.push(provider);
    }
    for (const [cacheKey, cached] of this.#cache.entries()) {
      if (cached.sessionId === sessionId) this.#cache.delete(cacheKey);
    }
    if (options.preserveSource !== true) {
      this.#providerSourceIdsBySession.delete(sessionId);
      this.#routeEpochsBySession.delete(sessionId);
      for (const bucketKey of this.#buckets.keys()) {
        if (bucketKey.startsWith(prefix)) this.#buckets.delete(bucketKey);
      }
      this.#admission.disposeSession(sessionId);
    } else if (options.nextRouteEpoch !== undefined) {
      this.#routeEpochsBySession.set(sessionId, options.nextRouteEpoch);
    }
    return providers;
  }

  #providerSourceId(provider: LLMProvider): number {
    const existing = this.#providerSourceIds.get(provider);
    if (existing !== undefined) return existing;
    const id = this.#nextProviderSourceId;
    this.#nextProviderSourceId += 1;
    this.#providerSourceIds.set(provider, id);
    return id;
  }

  async #predict(
    route: OwnedCodePredictionProvider,
    context: PreparedCodePredictionContext,
    signal: AbortSignal,
    config: BufferPredictionConfig,
  ): Promise<{
    readonly text: string;
    readonly model?: string;
    readonly usage?: LLMUsage;
  }> {
    const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxOutputTokens =
      config.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const provider = route.provider;
    if (typeof provider.predictCode === "function") {
      return await provider.predictCode(
        {
          prefix: context.prefix,
          suffix: context.suffix,
          ...(context.language !== undefined
            ? { language: context.language }
            : {}),
          path: context.relativePath,
          cursor: context.cursor,
        },
        {
          signal,
          timeoutMs,
          maxOutputTokens,
          temperature: 0,
          toolChoice: "none",
          tools: [],
          singleWireAttempt: true,
          skipCacheWrite: true,
        },
      );
    }
    const prompts = buildCodePredictionMessages(context);
    const response = await provider.chat(
      [{ role: "user", content: prompts.userPrompt }],
      {
        signal,
        systemPrompt: prompts.systemPrompt,
        timeoutMs,
        maxOutputTokens,
        temperature: 0,
        toolChoice: "none",
        tools: [],
        singleWireAttempt: true,
        skipCacheWrite: true,
      },
    );
    return {
      text: response.content,
      model: response.model,
      usage: response.usage,
    };
  }

  async #loadIgnore(
    source: CodePredictionSource,
    request: CodePredictionRequest,
  ): Promise<PredictionIgnoreMatcher | undefined> {
    const patterns: string[] = [];
    for (const name of [".agencignore", ".ignore", ".rgignore"]) {
      const content = await this.#readIgnoreFileFailClosed(
        join(source.workspaceRoot, name),
      );
      if (content !== undefined) patterns.push(content);
    }
    const explicit = compilePredictionIgnore(patterns);
    const directories = predictionIgnoreDirectories(source.workspaceRoot, [
      request.path,
      ...(request.relatedBuffers ?? []).map((buffer) => buffer.path),
    ]);
    const layers: GitIgnoreLayer[] = [];
    for (const directory of directories) {
      const content = await this.#readIgnoreFileFailClosed(
        join(directory, ".gitignore"),
      );
      if (content === undefined) continue;
      layers.push({
        base: relative(source.workspaceRoot, directory).split(sep).join("/"),
        matcher: ignore().add(content),
      });
    }
    if (explicit === undefined && layers.length === 0) return undefined;
    return {
      ignores(path): boolean {
        // AgenC-specific ignore rails are an explicit privacy boundary and
        // cannot be negated by repository metadata.
        if (explicit?.ignores(path)) return true;
        return gitIgnoreLayersIgnore(layers, path);
      },
    };
  }

  async #readIgnoreFileFailClosed(path: string): Promise<string | undefined> {
    const content = await this.#readIgnoreFile(path);
    if (content !== undefined) {
      this.#lastKnownIgnoreFiles.set(path, content);
      return content;
    }
    return this.#lastKnownIgnoreFiles.get(path);
  }

  async #canonicalizeRequest(
    source: CodePredictionSource,
    request: CodePredictionRequest,
  ): Promise<{
    readonly source: CodePredictionSource;
    readonly request: CodePredictionRequest;
  } | null> {
    if (!isPathInsideWorkspace(source.workspaceRoot, request.path)) return null;
    const canonicalRoot = await this.#realpath(source.workspaceRoot);
    const canonicalPath = await this.#canonicalizePath(request.path);
    if (!isPathInsideWorkspace(canonicalRoot, canonicalPath)) return null;
    const relatedBuffers: NonNullable<
      CodePredictionRequest["relatedBuffers"]
    >[number][] = [];
    for (const buffer of request.relatedBuffers ?? []) {
      if (!isPathInsideWorkspace(source.workspaceRoot, buffer.path)) continue;
      try {
        const path = await this.#canonicalizePath(buffer.path);
        if (!isPathInsideWorkspace(canonicalRoot, path)) continue;
        relatedBuffers.push({ ...buffer, path });
      } catch {
        // Related context is optional. Fail closed by excluding any path whose
        // canonical location cannot be established.
      }
    }
    return {
      source: { ...source, workspaceRoot: canonicalRoot },
      request: {
        ...request,
        path: canonicalPath,
        ...(request.relatedBuffers !== undefined ? { relatedBuffers } : {}),
      },
    };
  }

  async #canonicalizePath(path: string): Promise<string> {
    try {
      return await this.#realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await this.#realpath(dirname(path));
      return join(parent, basename(path));
    }
  }

  #takeToken(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? {
      tokens: TOKEN_BUCKET_CAPACITY,
      updatedAt: now,
    };
    bucket.tokens = Math.min(
      TOKEN_BUCKET_CAPACITY,
      bucket.tokens +
        Math.max(0, now - bucket.updatedAt) * TOKEN_BUCKET_REFILL_PER_MS,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return true;
  }

  #cacheKey(routeKey: string, context: PreparedCodePredictionContext): string {
    return createHash("sha256")
      .update(routeKey)
      .update("\0")
      .update(JSON.stringify(context))
      .digest("hex");
  }

  #isCurrent(editorKey: string, active: ActivePrediction): boolean {
    return (
      !active.controller.signal.aborted &&
      this.#activeByEditor.get(editorKey) === active
    );
  }

  #assertRequest(request: CodePredictionRequest): void {
    for (const [field, value] of [
      ["requestId", request.requestId],
      ["sessionId", request.sessionId],
      ["editorInstanceId", request.editorInstanceId],
      ["path", request.path],
    ] as const) {
      if (value.trim().length === 0) {
        throw new TypeError(`code prediction ${field} must be non-empty`);
      }
    }
    if (
      !Number.isSafeInteger(request.fileBytes) ||
      request.fileBytes < 0 ||
      request.fileBytes <
        utf8ByteLength(request.prefix) + utf8ByteLength(request.suffix)
    ) {
      throw new TypeError(
        "code prediction fileBytes must be a non-negative safe integer at least as large as the transmitted context",
      );
    }
    for (const [field, value] of [
      ["bufferHandle", request.bufferHandle],
      ["generation", request.generation],
      ["changedtick", request.changedtick],
      ["cursor.line", request.cursor.line],
      ["cursor.byteColumn", request.cursor.byteColumn],
    ] as const) {
      const minimum = field === "bufferHandle" ? 1 : 0;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(
          `code prediction ${field} must be a ${
            minimum === 1 ? "positive" : "non-negative"
          } safe integer`,
        );
      }
    }
    if ((request.diagnostics?.length ?? 0) > 8) {
      throw new TypeError(
        "code prediction diagnostics must contain at most 8 entries",
      );
    }
    if ((request.relatedBuffers?.length ?? 0) > 2) {
      throw new TypeError(
        "code prediction relatedBuffers must contain at most 2 entries",
      );
    }
  }

  #suppressed(
    request: CodePredictionRequest,
    reason: Extract<CodePredictionResult, { status: "suppressed" }>["reason"],
    startedAt: number,
  ): Extract<CodePredictionResult, { status: "suppressed" }> {
    this.#metric(
      request.sessionId,
      reason,
      Math.max(0, this.#now() - startedAt),
    );
    return {
      status: "suppressed",
      requestId: request.requestId,
      generation: request.generation,
      changedtick: request.changedtick,
      reason,
    };
  }

  #metric(
    sessionId: string,
    outcome: Extract<CodePredictionMetric, { type: "request" }>["outcome"],
    latencyMs: number,
  ): void {
    this.#emitMetric?.({
      type: "request",
      sessionId,
      outcome,
      latencyMs,
    });
  }
}

function predictionIgnoreDirectories(
  workspaceRoot: string,
  candidatePaths: readonly string[],
): readonly string[] {
  const root = resolve(workspaceRoot);
  const directories = new Set<string>([root]);
  for (const candidatePath of candidatePaths) {
    if (!isPathInsideWorkspace(root, candidatePath)) continue;
    const relativeDirectory = relative(root, dirname(resolve(candidatePath)));
    if (relativeDirectory === "") continue;
    let directory = root;
    for (const segment of relativeDirectory.split(sep)) {
      directory = join(directory, segment);
      directories.add(directory);
    }
  }
  return [...directories].sort((left, right) => {
    const leftDepth = relative(root, left).split(sep).filter(Boolean).length;
    const rightDepth = relative(root, right).split(sep).filter(Boolean).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
}

function gitIgnoreLayersIgnore(
  layers: readonly GitIgnoreLayer[],
  path: string,
): boolean {
  const normalizedPath = path
    .split("\\")
    .join("/")
    .replace(/^\.\/+/u, "");
  let ignored = false;
  const applied: GitIgnoreLayer[] = [];
  for (const layer of layers) {
    const candidate = relativeToGitIgnoreLayer(layer.base, normalizedPath);
    if (candidate === null) continue;
    // Git does not inspect a nested .gitignore after an ancestor rule has
    // excluded that directory, so a deeper negation cannot reopen it.
    if (layer.base !== "" && gitIgnoreLayerResults(applied, `${layer.base}/`)) {
      return true;
    }
    const result = layer.matcher.test(candidate);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
    applied.push(layer);
  }
  return ignored;
}

function gitIgnoreLayerResults(
  layers: readonly GitIgnoreLayer[],
  path: string,
): boolean {
  let ignored = false;
  for (const layer of layers) {
    const candidate = relativeToGitIgnoreLayer(layer.base, path);
    if (candidate === null || candidate === "") continue;
    const result = layer.matcher.test(candidate);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function relativeToGitIgnoreLayer(base: string, path: string): string | null {
  if (base === "") return path;
  if (!path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1);
}
