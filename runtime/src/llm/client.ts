/**
 * Session-scoped provider client factory.
 *
 * Keeps a provider/session split while staying source-compatible
 * with the existing runtime adapters.
 *
 * @module
 */

import {
  ProviderHttpClientSession,
  type ProviderHttpClientSessionConfig,
} from "./client-session.js";
import {
  resetResponsesContinuationState,
  type ResponsesContinuationState,
} from "./shape-request.js";

export interface ProviderHttpClientConfig
  extends ProviderHttpClientSessionConfig {}

export interface ProviderHttpContinuationSnapshot {
  readonly conversationId?: string;
  readonly lastRequest?: Readonly<Record<string, unknown>>;
  readonly lastResponseId?: string;
  readonly lastResponseOutput?: readonly Readonly<Record<string, unknown>>[];
}

function cloneContinuationState(
  state: Readonly<ResponsesContinuationState>,
): ResponsesContinuationState {
  return structuredClone(state);
}

function mergeRecords(
  base?: Readonly<Record<string, string>>,
  override?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeQuery(
  base?: Readonly<Record<string, string | number | boolean | undefined>>,
  override?: Readonly<Record<string, string | number | boolean | undefined>>,
): Readonly<Record<string, string | number | boolean | undefined>> | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

export class ProviderHttpClient {
  private readonly config: ProviderHttpClientConfig;
  private readonly responsesContinuationState: ResponsesContinuationState = {};
  private readonly transportReleases: Array<() => void> = [];

  constructor(config: ProviderHttpClientConfig) {
    this.config = config;
  }

  bindConversationId(conversationId: string): void {
    const trimmed = conversationId.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.responsesContinuationState.conversationId = trimmed;
  }

  clearResponsesResponseId(): void {
    // I-2: compaction invalidates the entire continuation baseline, not
    // just the last response id. Preserve only conversationId so the next
    // request re-seeds prompt_cache continuity from a clean slate.
    resetResponsesContinuationState(this.responsesContinuationState);
  }

  resetResponsesContinuation(): void {
    resetResponsesContinuationState(this.responsesContinuationState);
  }

  /**
   * A provider that keeps a connection open between requests registers how to
   * close it. The session calls `releaseTransports` when it shuts down and
   * when another provider takes over, so nothing stays connected (or
   * reconnects) for a provider nobody is using. A later request may connect
   * again.
   */
  registerTransportRelease(release: () => void): void {
    this.transportReleases.push(release);
  }

  releaseTransports(): void {
    for (const release of this.transportReleases) {
      try {
        release();
      } catch {
        // Closing a connection is best-effort.
      }
    }
  }

  snapshotResponsesContinuation(): ProviderHttpContinuationSnapshot {
    return Object.freeze(
      cloneContinuationState(this.responsesContinuationState),
    );
  }

  restoreResponsesContinuation(
    snapshot: ProviderHttpContinuationSnapshot,
  ): void {
    const restored = cloneContinuationState(snapshot);
    for (const key of Object.keys(this.responsesContinuationState)) {
      delete this.responsesContinuationState[
        key as keyof ResponsesContinuationState
      ];
    }
    Object.assign(this.responsesContinuationState, restored);
  }

  createTurnSession(
    overrides: Partial<ProviderHttpClientSessionConfig> = {},
  ): ProviderHttpClientSession {
    return new ProviderHttpClientSession({
      ...this.config,
      ...overrides,
      defaultHeaders: mergeRecords(
        this.config.defaultHeaders,
        overrides.defaultHeaders,
      ),
      defaultQuery: mergeQuery(
        this.config.defaultQuery,
        overrides.defaultQuery,
      ),
      authHeaders: mergeRecords(this.config.authHeaders, overrides.authHeaders),
      responsesContinuationState: this.responsesContinuationState,
    });
  }
}
