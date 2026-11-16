import { describe, expect, it, vi } from "vitest";
import { withPrintProviderPreconnect } from "./print-provider-preconnect.js";
import { resolveAgentRuntimeOptions } from "./runtime-options.js";

function fixture(signal?: AbortSignal) {
  const provider = { name: "openai", prewarmStartup: vi.fn(), dispose: vi.fn(), chat: vi.fn() };
  return { provider, conversationId: "print-test",
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true }),
    environment: { AGENC_OPENAI_PRINT_PRECONNECT: "1" }, ...(signal ? { signal } : {}) };
}

describe("early print pre-connect lifetime", () => {
  it("overlaps startup without waiting for the handshake and transfers ownership", async () => {
    const params = fixture();
    const handshake = Promise.withResolvers<void>();
    params.provider.prewarmStartup.mockReturnValue(handshake.promise);
    const result = await withPrintProviderPreconnect(params, async () => {
      expect(params.provider.prewarmStartup).toHaveBeenCalledTimes(1);
      return "session";
    });
    expect(result).toBe("session");
    expect(params.provider.dispose).not.toHaveBeenCalled();
    handshake.resolve();
  });

  it.each(["throw", "reject"])("keeps bootstrap usable when pre-connect fails: %s", async failure => {
    const params = fixture();
    params.provider.prewarmStartup.mockImplementation(() => {
      if (failure === "throw") throw new Error("offline");
      return Promise.reject(new Error("offline"));
    });
    await expect(withPrintProviderPreconnect(params, async () => "session")).resolves.toBe("session");
  });

  it("releases immediately on abort while bootstrap is still pending", async () => {
    const controller = new AbortController();
    const params = fixture(controller.signal);
    const startup = Promise.withResolvers<string>();
    const pending = withPrintProviderPreconnect(params, () => startup.promise);
    const failure = new Error("cancelled");
    controller.abort(failure);
    await Promise.resolve();
    expect(params.provider.dispose).toHaveBeenCalledTimes(1);
    startup.resolve("late session");
    await expect(pending).rejects.toBe(failure);
    expect(params.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("never opens a socket when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const params = fixture(controller.signal);
    const bootstrap = vi.fn();
    await expect(withPrintProviderPreconnect(params, bootstrap)).rejects.toThrow();
    expect(params.provider.prewarmStartup).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(params.provider.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains the startup error if disposal also fails", async () => {
    const params = fixture();
    params.provider.dispose.mockRejectedValue(new Error("cleanup"));
    const failure = new Error("startup");
    await expect(withPrintProviderPreconnect(params, async () => { throw failure; })).rejects.toBe(failure);
  });

  it("does not invoke any hook on non-OpenAI providers", async () => {
    for (const name of ["deepseek", "grok", "anthropic", "qwen", "openrouter"]) {
      const params = fixture();
      params.provider.name = name;
      await withPrintProviderPreconnect(params, async () => undefined);
      expect(params.provider.prewarmStartup).not.toHaveBeenCalled();
      expect(params.provider.dispose).not.toHaveBeenCalled();
    }
  });
});
