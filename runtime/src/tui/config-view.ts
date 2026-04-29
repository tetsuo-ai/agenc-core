import { useEffect, useState } from "react";

import { extractMentionAllowedRoots } from "../prompts/file-mentions.js";
import type {
  EditorMode,
  TuiLayoutConfig,
  VoiceInputConfig,
} from "../config/schema.js";
import type { ComposerAttachmentsConfig } from "./composer/Composer.js";
import type { ConfigStoreLike } from "./state/AppState.js";

function readStatusLineItems(config: unknown): readonly string[] | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const statusLine = (
    config as {
      readonly statusLine?: { readonly items?: unknown };
    }
  ).statusLine;
  if (!Array.isArray(statusLine?.items)) {
    return undefined;
  }
  const items = statusLine.items.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function readComposerAttachmentsConfig(
  config: unknown,
): ComposerAttachmentsConfig | undefined {
  const allowedRoots = extractMentionAllowedRoots(config);
  return allowedRoots !== undefined ? { allowedRoots } : undefined;
}

function readEditorMode(config: unknown): EditorMode | undefined {
  if (!config || typeof config !== "object") return undefined;
  const value = (config as { readonly editorMode?: unknown }).editorMode;
  return value === "vim" || value === "default" ? value : undefined;
}

function readVoiceInputConfig(config: unknown): VoiceInputConfig | undefined {
  if (!config || typeof config !== "object") return undefined;
  const value = (config as { readonly voiceInput?: unknown }).voiceInput;
  if (!value || typeof value !== "object") return undefined;
  return value as VoiceInputConfig;
}

function readTuiLayoutConfig(config: unknown): TuiLayoutConfig | undefined {
  if (!config || typeof config !== "object") return undefined;
  const value = (config as { readonly tuiLayout?: unknown }).tuiLayout;
  if (!value || typeof value !== "object") return undefined;
  return value as TuiLayoutConfig;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function readConfigWarnings(config: unknown): readonly string[] | undefined {
  if (!config || typeof config !== "object") return undefined;
  const record = config as {
    readonly configWarnings?: unknown;
    readonly warnings?: unknown;
    readonly _warnings?: unknown;
  };
  return (
    readStringArray(record.configWarnings) ??
    readStringArray(record.warnings) ??
    readStringArray(record._warnings)
  );
}

function readConfigStoreWarnings(
  configStore: ConfigStoreLike,
): readonly string[] | undefined {
  const warnings = (
    configStore as {
      readonly warnings?: () => readonly string[];
    }
  ).warnings;
  if (typeof warnings !== "function") return undefined;
  try {
    return readStringArray(warnings.call(configStore));
  } catch {
    return undefined;
  }
}

export interface TuiConfigView {
  readonly statusLineItems?: readonly string[];
  readonly composerAttachmentsConfig?: ComposerAttachmentsConfig;
  readonly editorMode?: EditorMode;
  readonly voiceInput?: VoiceInputConfig;
  readonly tuiLayout?: TuiLayoutConfig;
  readonly autoUpdates?: boolean;
  readonly configWarnings?: readonly string[];
}

export function readTuiConfigView(config: unknown): TuiConfigView {
  const statusLineItems = readStatusLineItems(config);
  const composerAttachmentsConfig = readComposerAttachmentsConfig(config);
  const editorMode = readEditorMode(config);
  const voiceInput = readVoiceInputConfig(config);
  const tuiLayout = readTuiLayoutConfig(config);
  const configWarnings = readConfigWarnings(config);
  const autoUpdates =
    !!config &&
    typeof config === "object" &&
    (config as { readonly autoUpdates?: unknown }).autoUpdates === true;
  return {
    ...(statusLineItems !== undefined ? { statusLineItems } : {}),
    ...(composerAttachmentsConfig !== undefined
      ? { composerAttachmentsConfig }
      : {}),
    ...(editorMode !== undefined ? { editorMode } : {}),
    ...(voiceInput !== undefined ? { voiceInput } : {}),
    ...(tuiLayout !== undefined ? { tuiLayout } : {}),
    ...(configWarnings !== undefined ? { configWarnings } : {}),
    autoUpdates,
  };
}

export function readTuiConfigViewFromStore(
  configStore: ConfigStoreLike,
): TuiConfigView {
  const configWarnings = readConfigStoreWarnings(configStore);
  const current = (
    configStore as {
      readonly current?: () => unknown;
      readonly snapshot?: unknown;
    }
  ).current;
  if (typeof current === "function") {
    try {
      return {
        ...readTuiConfigView(current.call(configStore)),
        ...(configWarnings !== undefined ? { configWarnings } : {}),
      };
    } catch {
      return configWarnings !== undefined ? { configWarnings } : {};
    }
  }
  return {
    ...readTuiConfigView(
      (configStore as { readonly snapshot?: unknown }).snapshot,
    ),
    ...(configWarnings !== undefined ? { configWarnings } : {}),
  };
}

export function useTuiConfigView(
  configStore: ConfigStoreLike,
): TuiConfigView {
  const [view, setView] = useState<TuiConfigView>(() =>
    readTuiConfigViewFromStore(configStore),
  );

  useEffect(() => {
    setView(readTuiConfigViewFromStore(configStore));

    const subscribe = (
      configStore as {
        readonly subscribe?: (
          listener: (config: unknown) => void,
        ) => (() => void) | void;
      }
    ).subscribe;
    if (typeof subscribe !== "function") {
      return undefined;
    }

    return subscribe.call(configStore, (nextConfig: unknown) => {
      const configWarnings = readConfigStoreWarnings(configStore);
      setView({
        ...readTuiConfigView(nextConfig),
        ...(configWarnings !== undefined ? { configWarnings } : {}),
      });
    });
  }, [configStore]);

  return view;
}
