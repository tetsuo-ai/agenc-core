import type { LLMProvider } from "../llm/types.js";
import type { AgentRuntimeOptions } from "./runtime-options.js";
import { preconnectProviderWhileSessionWaits } from "./startup-prewarm.js";

/** Own the optional socket until bootstrap hands the provider to its session. */
export async function withPrintProviderPreconnect<T>(
  params: {
    readonly provider: LLMProvider;
    readonly conversationId: string;
    readonly runtimeOptions: AgentRuntimeOptions;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  },
  bootstrap: () => Promise<T>,
): Promise<T> {
  const { provider, signal } = params;
  if (provider.name !== "openai" || params.runtimeOptions.nonInteractive !== true ||
    params.environment.AGENC_OPENAI_PRINT_PRECONNECT !== "1") return bootstrap();

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    // Promise construction also absorbs a synchronous dispose failure.
    disposal ??= Promise.resolve().then(() => provider.dispose?.());
    return disposal;
  };
  const abort = (): void => { void dispose().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  let transferred = false;
  try {
    signal?.throwIfAborted();
    // The final provider and conversation identity are already resolved. Use
    // this same instance for the turn so it shares the in-flight handshake.
    // The provider retains HTTP opt-out, proxy and injected-fetch decisions.
    preconnectProviderWhileSessionWaits({
      conversationId: params.conversationId,
      services: { provider, runtimeOptions: params.runtimeOptions },
    });
    const result = await bootstrap();
    signal?.throwIfAborted();
    transferred = true;
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!transferred) await dispose().catch(() => undefined);
  }
}
