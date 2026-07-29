import { describe, expect, it } from "vitest";

import {
  bufferProviderConfigFromEnv,
  bufferProviderConfigFromSources,
} from "../../../src/tui/workbench/buffer/providers/selectBufferEditorProvider.js";

describe("BUFFER provider config precedence", () => {
  it("maps typed config into provider discovery and operation settings", () => {
    expect(bufferProviderConfigFromSources({
      provider: "neovim",
      show_tabs: "always",
      neovim: {
        executable: "/opt/nvim",
        init: "clean",
        discovery_timeout_ms: 1_111,
        startup_timeout_ms: 2_222,
        operation_timeout_ms: 3_333,
        cleanup_timeout_ms: 444,
      },
    }, {})).toEqual({
      mode: "neovim",
      executable: "/opt/nvim",
      useUserInit: false,
      timeoutMs: 1_111,
      startupTimeoutMs: 2_222,
      operationTimeoutMs: 3_333,
      cleanupTimeoutMs: 444,
      sessionMode: "workspace",
    });
  });

  it("keeps environment overrides highest precedence", () => {
    const config = bufferProviderConfigFromSources({
      provider: "inline",
      neovim: {
        executable: "/config/nvim",
        init: "clean",
        startup_timeout_ms: 2_000,
      },
    }, {
      AGENC_BUFFER_PROVIDER: "neovim",
      AGENC_BUFFER_NVIM: "/env/nvim",
      AGENC_BUFFER_NVIM_USE_INIT: "true",
      AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS: "9000",
      AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS: "7000",
      AGENC_BUFFER_NVIM_SESSION: "file",
    });

    expect(config).toMatchObject({
      mode: "neovim",
      executable: "/env/nvim",
      useUserInit: true,
      startupTimeoutMs: 9_000,
      operationTimeoutMs: 7_000,
      sessionMode: "file",
    });
  });

  it("preserves legacy env-only defaults", () => {
    expect(bufferProviderConfigFromEnv({})).toEqual({
      mode: "auto",
      executable: undefined,
      useUserInit: undefined,
      timeoutMs: undefined,
      startupTimeoutMs: undefined,
      operationTimeoutMs: undefined,
      cleanupTimeoutMs: undefined,
      sessionMode: "workspace",
    });
  });
});
