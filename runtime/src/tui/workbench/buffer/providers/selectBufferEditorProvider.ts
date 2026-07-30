import {
  discoverNeovim,
  type NeovimDiscoveryConfig,
  type NeovimDiscoveryResult,
} from "../neovim/NeovimDiscovery.js";
import type { WorkbenchBufferStore } from "../BufferStore.js";
import { ExternalEditorProvider } from "./external/ExternalEditorProvider.js";
import { InlineBufferProvider } from "./inline/InlineBufferProvider.js";
import { NeovimBufferProvider } from "./neovim/NeovimBufferProvider.js";
import type { BufferEditorProvider } from "./types.js";
import type {
  EmbeddedNeovimStartupContext,
  EmbeddedNeovimStartupPreparation,
} from "../neovim/NeovimLifecycle.js";
import type {
  BufferConfig,
  BufferNeovimInitMode,
} from "../../../../config/schema.js";

export type BufferProviderMode = "auto" | "neovim" | "inline" | "external";

export type BufferProviderSelectionConfig = NeovimDiscoveryConfig & {
  readonly mode?: BufferProviderMode;
  readonly inlineStore?: WorkbenchBufferStore;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly sessionMode?: "workspace" | "file";
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly requireWorkspaceWriteAuthority?: boolean;
  readonly beforeOpenFile?: (
    context: EmbeddedNeovimStartupContext,
  ) => Promise<EmbeddedNeovimStartupPreparation | void>;
};

export type BufferProviderSelection =
  | {
      readonly kind: "neovim";
      readonly provider: BufferEditorProvider;
      readonly discovery: Extract<
        NeovimDiscoveryResult,
        { readonly usable: true }
      >;
      /**
       * Present only for `auto` mode. The controller may install the inline
       * provider only when the selected Neovim provider reports that every
       * configured startup attempt failed with cleanup confirmed.
       */
      readonly startupFailureFallback?: {
        readonly failureReason: () => string | null;
        readonly createProvider: (reason: string) => BufferEditorProvider;
      };
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
  const mode = config.mode ?? "auto";
  if (mode === "inline") {
    const reason =
      "Inline BUFFER selected by configuration. Vim behavior is basic fallback behavior.";
    return {
      kind: "inline",
      provider: new InlineBufferProvider({ reason, store: config.inlineStore }),
      discovery: null,
      reason,
    };
  }
  if (mode === "external") {
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
    const provider = new NeovimBufferProvider({
      discovery,
      startupTimeoutMs: config.startupTimeoutMs,
      operationTimeoutMs: config.operationTimeoutMs,
      cleanupTimeoutMs: config.cleanupTimeoutMs,
      sessionMode: config.sessionMode,
      workspaceRoot: config.workspaceRoot,
      agencHome: config.agencHome,
      requireWorkspaceWriteAuthority: config.requireWorkspaceWriteAuthority,
      beforeOpenFile: config.beforeOpenFile,
    });
    return {
      kind: "neovim",
      provider,
      discovery,
      ...(mode === "auto"
        ? {
            startupFailureFallback: {
              failureReason: () => provider.safeStartupFailureReason(),
              createProvider: (failureReason: string) => {
                const reason =
                  `Embedded Neovim startup failed after all configured attempts: ${failureReason} ` +
                  "Using basic inline BUFFER fallback.";
                return new InlineBufferProvider({
                  reason,
                  store: config.inlineStore,
                });
              },
            },
          }
        : {}),
    };
  }

  if (mode === "neovim") {
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
    provider: new InlineBufferProvider({
      reason: discovery.reason,
      store: config.inlineStore,
    }),
    discovery,
    reason: discovery.reason,
  };
}

export function bufferProviderConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BufferProviderSelectionConfig {
  return {
    mode: parseMode(env.AGENC_BUFFER_PROVIDER),
    executable: env.AGENC_BUFFER_NVIM,
    useUserInit: parseUseUserInit(env.AGENC_BUFFER_NVIM_USE_INIT),
    timeoutMs: parsePositiveInteger(env.AGENC_BUFFER_NVIM_TIMEOUT_MS),
    startupTimeoutMs: parsePositiveInteger(
      env.AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS,
    ),
    operationTimeoutMs: parsePositiveInteger(
      env.AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS,
    ),
    cleanupTimeoutMs: parsePositiveInteger(
      env.AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS,
    ),
    sessionMode: parseSessionMode(env.AGENC_BUFFER_NVIM_SESSION),
  };
}

export function bufferProviderConfigFromSources(
  config: BufferConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BufferProviderSelectionConfig {
  const neovim = config?.neovim;
  return {
    mode:
      env.AGENC_BUFFER_PROVIDER !== undefined
        ? parseMode(env.AGENC_BUFFER_PROVIDER)
        : (config?.provider ?? "auto"),
    executable: env.AGENC_BUFFER_NVIM ?? neovim?.executable,
    useUserInit:
      env.AGENC_BUFFER_NVIM_USE_INIT !== undefined
        ? parseUseUserInit(env.AGENC_BUFFER_NVIM_USE_INIT)
        : initModeToUseUserInit(neovim?.init),
    timeoutMs:
      parsePositiveInteger(env.AGENC_BUFFER_NVIM_TIMEOUT_MS) ??
      neovim?.discovery_timeout_ms,
    startupTimeoutMs:
      parsePositiveInteger(env.AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS) ??
      neovim?.startup_timeout_ms,
    operationTimeoutMs:
      parsePositiveInteger(env.AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS) ??
      neovim?.operation_timeout_ms,
    cleanupTimeoutMs:
      parsePositiveInteger(env.AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS) ??
      neovim?.cleanup_timeout_ms,
    sessionMode: parseSessionMode(env.AGENC_BUFFER_NVIM_SESSION),
  };
}

function parseMode(value: string | undefined): BufferProviderMode {
  if (
    value === "neovim" ||
    value === "inline" ||
    value === "external" ||
    value === "auto"
  )
    return value;
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
  if (normalized === "1" || normalized === "true" || normalized === "yes")
    return true;
  if (normalized === "0" || normalized === "false" || normalized === "no")
    return false;
  return undefined;
}

function initModeToUseUserInit(
  value: BufferNeovimInitMode | undefined,
): boolean | undefined {
  if (value === "user") return true;
  if (value === "clean") return false;
  return undefined;
}

function parseSessionMode(value: string | undefined): "workspace" | "file" {
  return value === "file" ? "file" : "workspace";
}
