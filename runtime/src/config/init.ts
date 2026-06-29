import {
  ConfigParseError,
  getErrnoCode,
} from "../utils/errors.js";
import { getGlobalAgenCFile } from "../utils/env.js";
import { getFsImplementation } from "../utils/fsOperations.js";
import { logForDiagnosticsNoPII } from "../utils/diagLogs.js";
import { stripBOM } from "../utils/jsonRead.js";

let configsEnabled = false;
let startupComplete = false;

/**
 * Startup gate for config reads used by the TUI/config layer.
 * Idempotent. CLI bootstrap calls this before any Ink tree or provider
 * setup path can touch global settings.
 */
export function enableConfigs(): void {
  if (startupComplete) return;

  const startTime = Date.now();
  logForDiagnosticsNoPII("info", "enable_configs_started");

  configsEnabled = true;
  validateGlobalConfig();
  startupComplete = true;

  logForDiagnosticsNoPII("info", "enable_configs_completed", {
    duration_ms: Date.now() - startTime,
  });
}

export function configReadsEnabled(): boolean {
  return configsEnabled;
}

export function assertConfigReadsEnabled(): void {
  if (!configsEnabled && process.env.NODE_ENV !== "test") {
    throw new Error("Config accessed before allowed.");
  }
}

export function __resetEnableConfigsForTest(): void {
  configsEnabled = false;
  startupComplete = false;
  (
    getGlobalAgenCFile as typeof getGlobalAgenCFile & {
      cache?: { clear?: () => void };
    }
  ).cache?.clear?.();
}

function validateGlobalConfig(): void {
  const file = getGlobalAgenCFile();
  const fs = getFsImplementation();
  let fileContent: string;

  try {
    fileContent = fs.readFileSync(file, { encoding: "utf-8" });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return;
    return;
  }

  try {
    JSON.parse(stripBOM(fileContent));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(message, file, createDefaultGlobalConfig());
  }
}

function createDefaultGlobalConfig(): Record<string, unknown> {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: "dark",
    preferredNotifChannel: "auto",
    verbose: false,
    editorMode: "normal",
    autoCompactEnabled: true,
    toolHistoryCompressionEnabled: true,
    showTurnDuration: true,
    showCacheStats: "compact",
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: "auto",
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    respectGitignore: true,
    copyFullResponse: false,
    providerProfiles: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
  };
}
