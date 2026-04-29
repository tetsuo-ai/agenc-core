import { LLMProviderError } from "../../errors.js";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000;

function buildLocalProviderDownError(
  providerLabel: string,
): LLMProviderError {
  return new LLMProviderError(
    providerLabel.toLowerCase(),
    `local provider lost connection - restart ${providerLabel} and retry.`,
  );
}

function isConnectionRefusedError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "ECONNREFUSED") return true;
  const message = String((error as { message?: unknown })?.message ?? "");
  return /ECONNREFUSED|connection refused/i.test(message);
}

export async function runLocalProviderHealthSidecar<T>(params: {
  readonly providerLabel: string;
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly healthCheck: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const intervalMs = params.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  let sidecarError: Error | undefined;

  const abortFromUpstream = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(params.signal?.reason);
    }
  };
  params.signal?.addEventListener("abort", abortFromUpstream, { once: true });

  const timer = setInterval(() => {
    void params.healthCheck()
      .then((healthy) => {
        if (healthy || sidecarError) return;
        sidecarError = buildLocalProviderDownError(params.providerLabel);
        if (!controller.signal.aborted) {
          controller.abort(sidecarError);
        }
      })
      .catch((error) => {
        if (!isConnectionRefusedError(error) || sidecarError) {
          return;
        }
        sidecarError = buildLocalProviderDownError(params.providerLabel);
        if (!controller.signal.aborted) {
          controller.abort(sidecarError);
        }
      });
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  try {
    const result = await params.operation(controller.signal);
    if (sidecarError) throw sidecarError;
    return result;
  } catch (error) {
    if (sidecarError) throw sidecarError;
    throw error;
  } finally {
    clearInterval(timer);
    params.signal?.removeEventListener("abort", abortFromUpstream);
  }
}
