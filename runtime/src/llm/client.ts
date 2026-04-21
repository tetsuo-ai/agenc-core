/**
 * Session-scoped HTTP client factory for provider adapters.
 *
 * Mirrors the session/turn split expected by T13 without pulling the
 * full codex `client.rs` abstraction into the runtime yet.
 *
 * @module
 */

import {
  ProviderHttpClientSession,
  type ProviderHttpClientSessionConfig,
} from "./client-session.js";

export interface ProviderHttpClientConfig
  extends ProviderHttpClientSessionConfig {}

export class ProviderHttpClient {
  private readonly config: ProviderHttpClientConfig;

  constructor(config: ProviderHttpClientConfig) {
    this.config = config;
  }

  createTurnSession(
    overrides: Partial<ProviderHttpClientSessionConfig> = {},
  ): ProviderHttpClientSession {
    return new ProviderHttpClientSession({
      ...this.config,
      ...overrides,
      defaultHeaders: {
        ...(this.config.defaultHeaders ?? {}),
        ...(overrides.defaultHeaders ?? {}),
      },
    });
  }
}
