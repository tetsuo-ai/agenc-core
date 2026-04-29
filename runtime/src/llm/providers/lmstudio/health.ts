import { runLocalProviderHealthSidecar } from "../shared/local-health.js";

export async function withLmstudioHealthSidecar<T>(params: {
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly healthCheck: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}): Promise<T> {
  return await runLocalProviderHealthSidecar({
    providerLabel: "LMStudio",
    operation: params.operation,
    healthCheck: params.healthCheck,
    signal: params.signal,
    intervalMs: params.intervalMs,
  });
}
