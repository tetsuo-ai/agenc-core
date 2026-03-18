/**
 * Gateway config init/validate/show commands.
 *
 * Provides a non-interactive setup wizard for generating gateway configuration,
 * and commands to validate and display existing configs.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  getDefaultConfigPath,
  loadGatewayConfig,
  validateGatewayConfig,
} from "../gateway/config-watcher.js";
import {
  scaffoldWorkspace,
  getDefaultWorkspacePath,
} from "../gateway/workspace-files.js";
import type { GatewayConfig } from "../gateway/types.js";
import {
  applyManagedGatewayPatch,
  buildManagedGatewayPatch,
  writeJsonAtomically,
} from "./config-contract.js";
import { DEFAULT_SQLITE_REPLAY_PATH } from "./replay.js";
import type {
  CliFileConfig,
  CliRuntimeContext,
  CliStatusCode,
  WizardOptions,
  ConfigValidateOptions,
  ConfigShowOptions,
} from "./types.js";

// ============================================================================
// Default config generation
// ============================================================================

/** Detect the default Solana keypair path if it exists. */
export function detectSolanaKeypair(): string | null {
  const defaultPath = join(homedir(), ".config", "solana", "id.json");
  return existsSync(defaultPath) ? defaultPath : null;
}

/** Generate a valid GatewayConfig with sane defaults, optionally merging overrides. */
export function generateDefaultConfig(
  overrides?: Partial<GatewayConfig>,
): GatewayConfig {
  const keypairPath = detectSolanaKeypair() ?? undefined;

  const base: GatewayConfig = {
    gateway: {
      port: 3100,
    },
    agent: {
      name: "agenc-agent",
    },
    connection: {
      rpcUrl: "https://api.devnet.solana.com",
      ...(keypairPath ? { keypairPath } : {}),
    },
    logging: {
      level: "info",
    },
    replay: {
      store: {
        type: "sqlite",
        sqlitePath: DEFAULT_SQLITE_REPLAY_PATH,
      },
    },
    cli: {
      strictMode: false,
      idempotencyWindow: 900,
      outputFormat: "json",
    },
  };

  if (!overrides) return base;

  const result: GatewayConfig = {
    gateway: { ...base.gateway, ...overrides.gateway },
    agent: { ...base.agent, ...overrides.agent },
    connection: { ...base.connection, ...overrides.connection },
    logging: { ...base.logging, ...overrides.logging },
    replay:
      overrides.replay || base.replay
        ? {
            ...(base.replay ?? {}),
            ...(overrides.replay ?? {}),
            store:
              overrides.replay?.store || base.replay?.store
                ? {
                    ...(base.replay?.store ?? {}),
                    ...(overrides.replay?.store ?? {}),
                  }
                : undefined,
            tracing:
              overrides.replay?.tracing || base.replay?.tracing
                ? {
                    ...(base.replay?.tracing ?? {}),
                    ...(overrides.replay?.tracing ?? {}),
                  }
                : undefined,
            backfill:
              overrides.replay?.backfill || base.replay?.backfill
                ? {
                    ...(base.replay?.backfill ?? {}),
                    ...(overrides.replay?.backfill ?? {}),
                  }
                : undefined,
          }
        : undefined,
    cli:
      overrides.cli || base.cli
        ? {
            ...(base.cli ?? {}),
            ...(overrides.cli ?? {}),
          }
        : undefined,
  };

  if (overrides.llm) result.llm = overrides.llm;
  if (overrides.memory) result.memory = overrides.memory;
  if (overrides.channels) result.channels = overrides.channels;
  if (overrides.plugins) result.plugins = overrides.plugins;
  if (overrides.policy) result.policy = overrides.policy;
  if (overrides.auth) result.auth = overrides.auth;
  if (overrides.workspace) result.workspace = overrides.workspace;
  if (overrides.desktop) result.desktop = overrides.desktop;
  if (overrides.approvals) result.approvals = overrides.approvals;
  if (overrides.marketplace) result.marketplace = overrides.marketplace;
  if (overrides.social) result.social = overrides.social;
  if (overrides.autonomy) result.autonomy = overrides.autonomy;

  return result;
}

function buildWizardManagedCliConfig(
  options: WizardOptions,
): Partial<CliFileConfig> {
  const storeType = options.managedOverrides?.storeType ?? options.storeType;
  const sqlitePath =
    storeType === "sqlite"
      ? (options.managedOverrides?.sqlitePath ??
        options.sqlitePath ??
        DEFAULT_SQLITE_REPLAY_PATH)
      : undefined;

  return {
    rpcUrl: options.managedOverrides?.rpcUrl ?? options.rpcUrl,
    programId: options.managedOverrides?.programId ?? options.programId,
    storeType,
    ...(sqlitePath ? { sqlitePath } : {}),
    traceId: options.managedOverrides?.traceId ?? options.traceId,
    strictMode: options.managedOverrides?.strictMode ?? options.strictMode,
    idempotencyWindow:
      options.managedOverrides?.idempotencyWindow ?? options.idempotencyWindow,
    outputFormat: options.managedOverrides?.outputFormat,
    logLevel: options.managedOverrides?.logLevel,
  };
}

// ============================================================================
// config init
// ============================================================================

export async function runConfigInitCommand(
  context: CliRuntimeContext,
  options: WizardOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath ?? getDefaultConfigPath());
  const configExists = existsSync(configPath);

  if (configExists && !options.force) {
    context.output({
      status: "ok",
      command: "config.init",
      skipped: true,
      message: `Config already exists at ${configPath}. Use --force to overwrite.`,
      configPath,
    });
    return 0;
  }

  const config = applyManagedGatewayPatch(
    generateDefaultConfig(),
    buildManagedGatewayPatch(buildWizardManagedCliConfig(options)),
  );

  const validation = validateGatewayConfig(config);
  if (!validation.valid) {
    context.error({
      status: "error",
      command: "config.init",
      message: `Generated config is invalid: ${validation.errors.join("; ")}`,
    });
    return 1;
  }

  // Write config
  try {
    writeJsonAtomically(configPath, config);
  } catch (err) {
    context.error({
      status: "error",
      command: "config.init",
      message: `Failed to write config: ${(err as Error).message}`,
    });
    return 1;
  }

  // Scaffold workspace
  const workspacePath = getDefaultWorkspacePath();
  let scaffolded: string[] = [];
  try {
    scaffolded = await scaffoldWorkspace(workspacePath);
  } catch (err) {
    context.error({
      status: "error",
      command: "config.init",
      message: `Config written but workspace scaffold failed: ${(err as Error).message}`,
      configPath,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "config.init",
    configPath,
    workspacePath,
    configCreated: true,
    workspaceFilesCreated: scaffolded,
    keypairDetected: detectSolanaKeypair() !== null,
  });

  return 0;
}

// ============================================================================
// config validate
// ============================================================================

export async function runConfigValidateCommand(
  context: CliRuntimeContext,
  options: ConfigValidateOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath ?? getDefaultConfigPath());

  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch (err) {
    context.error({
      status: "error",
      command: "config.validate",
      message: `Failed to load config: ${(err as Error).message}`,
      configPath,
    });
    return 1;
  }

  const validation = validateGatewayConfig(config);
  if (!validation.valid) {
    context.error({
      status: "error",
      command: "config.validate",
      errors: validation.errors,
      configPath,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "config.validate",
    valid: true,
    configPath,
  });

  return 0;
}

// ============================================================================
// config show
// ============================================================================

export async function runConfigShowCommand(
  context: CliRuntimeContext,
  options: ConfigShowOptions,
): Promise<CliStatusCode> {
  const configPath = resolve(options.configPath ?? getDefaultConfigPath());

  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig(configPath);
  } catch (err) {
    context.error({
      status: "error",
      command: "config.show",
      message: `Failed to load config: ${(err as Error).message}`,
      configPath,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "config.show",
    configPath,
    config,
  });

  return 0;
}
