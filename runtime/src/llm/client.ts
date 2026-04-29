/**
 * Session-scoped provider client factory.
 *
 * Mirrors codex runtime's provider/session split while staying source-compatible
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
