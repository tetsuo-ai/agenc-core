/**
 * Operator onboarding workflow for bootstrapping runtime CLI configuration.
 *
 * @module
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { getDefaultPidPath, isProcessAlive, readPidFile } from "../gateway/daemon.js";
import { DEFAULT_SQLITE_REPLAY_PATH } from "./replay.js";
import {
  applyManagedGatewayPatch,
  buildManagedGatewayPatch,
  createConfigBackup,
  getCanonicalDefaultConfigPath,
  loadCliConfigContract,
  writeJsonAtomically,
  type LoadedCliConfigContract,
} from "./config-contract.js";
import { findDaemonProcessesByIdentity } from "./daemon.js";
import type {
  CliFileConfig,
  CliRuntimeContext,
  OnboardOptions,
} from "./types.js";
import { validateGatewayConfig } from "../gateway/config-watcher.js";
import {
  type HealthCheckResult,
  checkConfigValidity,
  checkRpcReachability,
  checkWalletAvailability,
} from "./health.js";
import { generateDefaultConfig } from "./wizard.js";

/** Onboard configuration output. */
export interface OnboardResult {
  configPath: string;
  configGenerated: boolean;
  backupPath?: string;
  importedLegacyConfigPath?: string | null;
  walletDetected: boolean;
  rpcReachable: boolean;
  checks: HealthCheckResult[];
  exitCode: 0 | 1 | 2;
}

function computeExitCode(checks: HealthCheckResult[]): 0 | 1 | 2 {
  const hasErrors = checks.some((check) => check.status === "fail");
  const hasWarnings = checks.some((check) => check.status === "warn");
  return hasErrors ? 2 : hasWarnings ? 1 : 0;
}

function mergeCliFileConfig(
  base: CliFileConfig,
  override: CliFileConfig,
): CliFileConfig {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).filter(([, value]) => value !== undefined),
    ),
  };
}

function buildOnboardManagedConfig(options: OnboardOptions): CliFileConfig {
  const source =
    options.managedOverrides ?? {
      rpcUrl: options.rpcUrl,
      programId: options.programId,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
      traceId: options.traceId,
      strictMode: options.strictMode,
      idempotencyWindow: options.idempotencyWindow,
      outputFormat: options.outputFormat,
      logLevel: "info",
    };
  const storeType = source.storeType;
  const sqlitePath =
    storeType === "sqlite"
      ? (source.sqlitePath ?? DEFAULT_SQLITE_REPLAY_PATH)
      : undefined;

  return {
    rpcUrl: source.rpcUrl,
    programId: source.programId,
    ...(storeType ? { storeType } : {}),
    ...(sqlitePath ? { sqlitePath } : {}),
    traceId: source.traceId,
    logLevel: source.logLevel,
    outputFormat: source.outputFormat,
    strictMode: source.strictMode,
    idempotencyWindow: source.idempotencyWindow,
  };
}

async function ensureTargetConfigNotLive(
  configPath: string,
  checks: HealthCheckResult[],
): Promise<boolean> {
  const resolvedConfigPath = path.resolve(configPath);
  const pidInfo = await readPidFile(getDefaultPidPath());
  if (
    pidInfo &&
    isProcessAlive(pidInfo.pid) &&
    path.resolve(pidInfo.configPath) === resolvedConfigPath
  ) {
    checks.push({
      id: "config.live-daemon",
      category: "config",
      status: "fail",
      message: `Refusing to mutate config at ${resolvedConfigPath} while daemon ${pidInfo.pid} is running against it`,
      remediation: "Run `agenc stop` (or `agenc-runtime stop`) before onboarding with --force",
    });
    return false;
  }

  const matches = await findDaemonProcessesByIdentity({
    configPath: resolvedConfigPath,
  });
  const liveMatches = matches.filter((entry) => isProcessAlive(entry.pid));
  if (liveMatches.length > 0) {
    checks.push({
      id: "config.live-daemon",
      category: "config",
      status: "fail",
      message: `Refusing to mutate config at ${resolvedConfigPath} while matching daemon process(es) are live: ${liveMatches.map((entry) => entry.pid).join(", ")}`,
      remediation: "Run `agenc stop` (or `agenc-runtime stop`) before onboarding with --force",
    });
    return false;
  }

  return true;
}

function loadExistingContract(
  configPath: string,
  source: OnboardOptions["configPathSource"],
): {
  contract: LoadedCliConfigContract;
  loadError: Error | null;
} {
  try {
    return {
      contract: loadCliConfigContract(configPath, {
        configPathSource: source,
      }),
      loadError: null,
    };
  } catch (error) {
    return {
      contract: {
        shape: "missing",
        configPath,
        fileConfig: {},
      },
      loadError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export async function runOnboardCommand(
  context: CliRuntimeContext,
  options: OnboardOptions,
): Promise<0 | 1 | 2> {
  const checks: HealthCheckResult[] = [];

  const configPath = path.resolve(
    options.configPath ?? getCanonicalDefaultConfigPath(),
  );
  const configExists = existsSync(configPath);
  const { contract: existingContract, loadError } = loadExistingContract(
    configPath,
    options.configPathSource,
  );
  if (loadError && configExists && !options.force) {
    checks.push({
      id: "config.valid",
      category: "config",
      status: "fail",
      message: `Existing config at ${configPath} is invalid: ${loadError.message}`,
      remediation: "Fix the file manually or rerun onboard with --force to rebuild the canonical config",
    });
  } else if (configExists && !options.force) {
    checks.push({
      id: "config.exists",
      category: "config",
      status: "warn",
      message: `Config file already exists at ${configPath}. Use --force to overwrite.`,
    });
  }

  const managedConfig = buildOnboardManagedConfig(options);
  let importedLegacyConfigPath: string | null = null;
  let importedFileConfig: CliFileConfig = {};
  if (
    options.legacyImportConfigPath &&
    path.resolve(options.legacyImportConfigPath) !== configPath
  ) {
    try {
      const importedContract = loadCliConfigContract(
        options.legacyImportConfigPath,
        {
          configPathSource: "env:AGENC_RUNTIME_CONFIG",
        },
      );
      importedLegacyConfigPath = options.legacyImportConfigPath;
      importedFileConfig = importedContract.fileConfig;
    } catch (error) {
      checks.push({
        id: "config.import",
        category: "config",
        status: "fail",
        message: `Legacy import source ${options.legacyImportConfigPath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Unset AGENC_RUNTIME_CONFIG or fix the legacy config before running onboard",
      });
    }
  }

  const baseConfig =
    existingContract.shape === "canonical-gateway" && existingContract.gatewayConfig
      ? existingContract.gatewayConfig
      : generateDefaultConfig();
  const importedConfig = applyManagedGatewayPatch(
    baseConfig,
    buildManagedGatewayPatch(importedFileConfig),
  );
  const finalConfig = applyManagedGatewayPatch(
    importedConfig,
    buildManagedGatewayPatch(managedConfig),
  );
  const validation = validateGatewayConfig(finalConfig);
  if (!validation.valid) {
    checks.push({
      id: "config.generated",
      category: "config",
      status: "fail",
      message: `Generated config failed validation: ${validation.errors.join("; ")}`,
      remediation: "Fix runtime defaults or supply explicit config values",
    });
  }

  let backupPath: string | undefined;
  let configGenerated = false;
  if ((!configExists || options.force) && validation.valid) {
    const safeToMutate = await ensureTargetConfigNotLive(configPath, checks);
    if (!safeToMutate) {
      configGenerated = false;
    } else {
      try {
        if (configExists) {
          backupPath = createConfigBackup(configPath);
        }
        writeJsonAtomically(configPath, finalConfig);
        configGenerated = true;
        checks.push({
          id: "config.generated",
          category: "config",
          status: "pass",
          message: `Config written to ${configPath}`,
        });
        if (backupPath) {
          checks.push({
            id: "config.backup",
            category: "config",
            status: "pass",
            message: `Existing config backed up to ${backupPath}`,
          });
        }
        if (importedLegacyConfigPath) {
          checks.push({
            id: "config.import",
            category: "config",
            status: "pass",
            message: `Imported managed runtime settings from ${importedLegacyConfigPath}`,
          });
        }
      } catch (error) {
        checks.push({
          id: "config.generated",
          category: "config",
          status: "fail",
          message: `Failed to write config to ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "Ensure the config directory is writable",
        });
      }
    }
  }

  const effectiveFileConfig = configGenerated
    ? loadCliConfigContract(configPath, {
        configPathSource: options.configPathSource ?? "canonical",
      }).fileConfig
    : existingContract.shape === "missing"
      ? mergeCliFileConfig(importedFileConfig, managedConfig)
      : existingContract.fileConfig;

  const walletDetected = await checkWalletAvailability(checks);
  const rpcUrl = effectiveFileConfig.rpcUrl;
  const rpcReachable = await checkRpcReachability(rpcUrl, checks);

  checkConfigValidity(
    configPath,
    checks,
    options.configPathSource ?? "canonical",
  );

  const exitCode = computeExitCode(checks);

  const result: OnboardResult = {
    configPath,
    configGenerated,
    ...(backupPath ? { backupPath } : {}),
    importedLegacyConfigPath,
    walletDetected,
    rpcReachable,
    checks,
    exitCode,
  };

  context.output({
    status: "ok",
    command: "onboard",
    result,
  });

  return exitCode;
}
