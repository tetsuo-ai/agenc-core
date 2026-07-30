import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgenCConfigEditsBuilder } from "../../src/config/edit.js";
import { parseToml } from "../../src/config/loader.js";
import {
  defaultConfig,
  InvalidBufferConfigError,
  normalizeRawConfig,
  validateAgenCConfigBlocks,
  validateBufferConfig,
} from "../../src/config/schema.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("buffer editor config", () => {
  it("ships safe workspace defaults", () => {
    expect(defaultConfig().buffer).toEqual({
      provider: "auto",
      show_tabs: "auto",
      neovim: {
        init: "auto",
        startup_timeout_ms: 10_000,
        operation_timeout_ms: 10_000,
        cleanup_timeout_ms: 1_000,
      },
      prediction: {
        enabled: "ask",
        debounce_ms: 160,
        timeout_ms: 2_500,
        max_output_tokens: 256,
      },
    });
  });

  it("normalizes and validates the complete closed schema", () => {
    const normalized = normalizeRawConfig({
      buffer: {
        provider: "neovim",
        show_tabs: "always",
        neovim: {
          executable: "/opt/nvim/bin/nvim",
          init: "clean",
          discovery_timeout_ms: 900,
          startup_timeout_ms: 8_000,
          operation_timeout_ms: 4_000,
          cleanup_timeout_ms: 750,
        },
        prediction: {
          enabled: "on",
          debounce_ms: 80,
          timeout_ms: 1_500,
          max_output_tokens: 192,
          provider: "grok",
          model: "grok-code-fast-1",
        },
      },
    });

    expect(validateAgenCConfigBlocks(normalized).buffer).toEqual({
      provider: "neovim",
      show_tabs: "always",
      neovim: {
        executable: "/opt/nvim/bin/nvim",
        init: "clean",
        discovery_timeout_ms: 900,
        startup_timeout_ms: 8_000,
        operation_timeout_ms: 4_000,
        cleanup_timeout_ms: 750,
      },
      prediction: {
        enabled: "on",
        debounce_ms: 80,
        timeout_ms: 1_500,
        max_output_tokens: 192,
        provider: "grok",
        model: "grok-code-fast-1",
      },
    });
    expect(normalized._unknown).toBeUndefined();
  });

  it("rejects misspelled fields and invalid deadlines", () => {
    expect(() =>
      validateBufferConfig({
        provider: "nvim",
      }),
    ).toThrow(InvalidBufferConfigError);
    expect(() =>
      validateBufferConfig({
        neovim: { startup_timeout_ms: 0 },
      }),
    ).toThrow(/positive integer/u);
    expect(() =>
      validateBufferConfig({
        neovim: { start_timeout_ms: 1_000 },
      }),
    ).toThrow(/unknown field/u);
    expect(() =>
      validateBufferConfig({
        prediction: { enabled: true },
      }),
    ).toThrow(/prediction\.enabled/u);
    expect(() =>
      validateBufferConfig({
        prediction: { debounce_ms: 10 },
      }),
    ).toThrow(/between 25 and 5000/u);
    expect(() =>
      validateBufferConfig({
        prediction: { timeout_ms: 30_001 },
      }),
    ).toThrow(/between 100 and 30000/u);
    expect(() =>
      validateBufferConfig({
        prediction: { provider: " " },
      }),
    ).toThrow(/non-empty string/u);
  });

  it("writes editor settings atomically through the config builder", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-buffer-config-"));
    cleanup.push(home);

    await new AgenCConfigEditsBuilder(home)
      .setBufferEditorConfig({
        provider: "inline",
        show_tabs: "never",
        neovim: {
          init: "user",
          operation_timeout_ms: 12_345,
        },
        prediction: {
          enabled: "on",
          debounce_ms: 120,
          timeout_ms: 2_000,
          max_output_tokens: 128,
          provider: "openai",
          model: "gpt-5-mini",
        },
      })
      .apply();

    const raw = parseToml(
      await readFile(join(home, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw.buffer).toEqual({
      provider: "inline",
      show_tabs: "never",
      neovim: {
        init: "user",
        operation_timeout_ms: 12_345,
      },
      prediction: {
        enabled: "on",
        debounce_ms: 120,
        timeout_ms: 2_000,
        max_output_tokens: 128,
        provider: "openai",
        model: "gpt-5-mini",
      },
    });
  });
});
