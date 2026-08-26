import { afterEach, describe, expect, test, vi } from "vitest";

import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import {
  clearPostSamplingHooks,
  executePostSamplingHooks,
  registerPostSamplingHook,
} from "../../src/utils/hooks/postSamplingHooks.js";

describe("post-sampling simple-mode suppression", () => {
  afterEach(() => {
    clearPostSamplingHooks();
  });

  test("runs zero callbacks for simple mode while retaining non-simple behavior", async () => {
    const callback = vi.fn(async () => undefined);
    registerPostSamplingHook(callback);

    const execute = () =>
      executePostSamplingHooks(
        [],
        {} as never,
        { user: "context" },
        { system: "context" },
        {} as never,
        "repl_main_thread",
      );

    await runWithAgentRuntimeOptions(
      resolveAgentRuntimeOptions({}, { simpleMode: true }),
      execute,
    );
    expect(callback).not.toHaveBeenCalled();

    await runWithAgentRuntimeOptions(
      resolveAgentRuntimeOptions({}, { simpleMode: false }),
      execute,
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [],
        userContext: { user: "context" },
        systemContext: { system: "context" },
        querySource: "repl_main_thread",
      }),
    );
  });
});
