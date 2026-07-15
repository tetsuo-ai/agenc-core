import { discoverNeovim, type NeovimDiscoveryConfig, type NeovimDiscoveryResult } from "../neovim/NeovimDiscovery.js";
import type { WorkbenchBufferStore } from "../BufferStore.js";
import { ExternalEditorProvider } from "./external/ExternalEditorProvider.js";
import { InlineBufferProvider } from "./inline/InlineBufferProvider.js";
import { NeovimBufferProvider } from "./neovim/NeovimBufferProvider.js";
import type { BufferEditorProvider } from "./types.js";

export type BufferProviderMode = "auto" | "neovim" | "inline" | "external";

export type BufferProviderSelectionConfig = NeovimDiscoveryConfig & {
  readonly mode?: BufferProviderMode;
  readonly inlineStore?: WorkbenchBufferStore;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
};

export type BufferProviderSelection =
  | {
      readonly kind: "neovim";
      readonly provider: BufferEditorProvider;
      readonly discovery: Extract<NeovimDiscoveryResult, { readonly usable: true }>;
    }
  | {
      readonly kind: "inline";
      readonly provider: BufferEditorProvider;
      readonly discovery: NeovimDiscoveryResult | null;
      readonly reason: string;
    }
  | {
      readonly kind: "external";
      readonly provider: BufferEditorProvider;
      readonly discovery: null;
      readonly reason: string;
    };

export async function selectBufferEditorProvider(
  config: BufferProviderSelectionConfig = {},
): Promise<BufferProviderSelection> {
  if (config.mode === "inline") {
    const reason = "Inline BUFFER selected by configuration. Vim behavior is basic fallback behavior.";
    return {
      kind: "inline",
      provider: new InlineBufferProvider({ reason, store: config.inlineStore }),
      discovery: null,
      reason,
    };
  }
  if (config.mode === "external") {
    const reason = "External editor BUFFER handoff selected explicitly.";
    return {
      kind: "external",
      provider: new ExternalEditorProvider(),
      discovery: null,
      reason,
    };
  }

  const discovery = await discoverNeovim(config);
  if (discovery.usable) {
    return {
      kind: "neovim",
      provider: new NeovimBufferProvider({
        discovery,
        startupTimeoutMs: config.startupTimeoutMs,
        cleanupTimeoutMs: config.cleanupTimeoutMs,
      }),
      discovery,
    };
  }

  if (config.mode === "neovim") {
    const reason = `${discovery.reason} Inline BUFFER is available as the basic fallback.`;
    return {
      kind: "inline",
      provider: new InlineBufferProvider({ reason, store: config.inlineStore }),
      discovery,
      reason,
    };
  }

  return {
    kind: "inline",
    provider: new InlineBufferProvider({ reason: discovery.reason, store: config.inlineStore }),
    discovery,
    reason: discovery.reason,
  };
}

export function bufferProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BufferProviderSelectionConfig {
  return {
    mode: parseMode(env.AGENC_BUFFER_PROVIDER),
    executable: env.AGENC_BUFFER_NVIM,
    useUserInit: parseUseUserInit(env.AGENC_BUFFER_NVIM_USE_INIT),
    timeoutMs: parsePositiveInteger(env.AGENC_BUFFER_NVIM_TIMEOUT_MS),
    startupTimeoutMs: parsePositiveInteger(env.AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS),
    cleanupTimeoutMs: parsePositiveInteger(env.AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS),
  };
}

function parseMode(value: string | undefined): BufferProviderMode {
  if (value === "neovim" || value === "inline" || value === "external" || value === "auto") return value;
  return "auto";
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseUseUserInit(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}
