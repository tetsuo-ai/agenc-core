import type { AgenCConfig, AuthBackendConfigKind } from "../config/schema.js";
import { applyEnvOverrides, type EnvSnapshot } from "../config/env.js";
import type { AuthBackend } from "./backend.js";
import {
  LocalAuthBackend,
  type LocalAuthBackendOptions,
} from "./backends/local.js";
import {
  RemoteAuthBackend,
  type RemoteAuthBackendOptions,
} from "./backends/remote.js";

export interface AuthBackendSelectionOptions {
  readonly agencHome?: string;
  readonly env?: EnvSnapshot;
  readonly remote?: RemoteAuthBackendOptions;
}

class InvalidAuthBackendConfigError extends Error {
  constructor(value: unknown) {
    super(
      `Invalid auth.backend config: expected "local" or "remote", got ${JSON.stringify(value)}`,
    );
    this.name = "InvalidAuthBackendConfigError";
  }
}

class InvalidAuthManagedKeysConfigError extends Error {
  constructor(value: unknown) {
    super(
      `Invalid auth.managedKeys.enabled config: expected boolean, got ${JSON.stringify(value)}`,
    );
    this.name = "InvalidAuthManagedKeysConfigError";
  }
}

function readAuthConfig(
  config: Pick<AgenCConfig, "auth">,
): Record<string, unknown> | undefined {
  const auth = (config as { readonly auth?: unknown }).auth;
  if (auth === undefined) return undefined;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new InvalidAuthBackendConfigError(auth);
  }
  return auth as Record<string, unknown>;
}

export function resolveAuthManagedKeysEnabled(
  config: Pick<AgenCConfig, "auth">,
): boolean {
  const auth = readAuthConfig(config);
  const managedKeys = auth?.managedKeys;
  if (managedKeys === undefined) return false;
  if (
    !managedKeys ||
    typeof managedKeys !== "object" ||
    Array.isArray(managedKeys)
  ) {
    throw new InvalidAuthManagedKeysConfigError(managedKeys);
  }
  const enabled = (managedKeys as { readonly enabled?: unknown }).enabled;
  if (enabled === undefined) return false;
  if (typeof enabled === "boolean") return enabled;
  throw new InvalidAuthManagedKeysConfigError(enabled);
}

function resolveAuthBackendKind(
  config: Pick<AgenCConfig, "auth">,
): AuthBackendConfigKind {
  const auth = readAuthConfig(config);
  if (auth === undefined) return "remote";
  resolveAuthManagedKeysEnabled(config);
  const backend = auth.backend;
  if (backend === undefined) return "remote";
  if (backend === "local" || backend === "remote") return backend;
  throw new InvalidAuthBackendConfigError(backend);
}

export function createAuthBackend(
  config: Pick<AgenCConfig, "auth">,
  options: AuthBackendSelectionOptions = {},
): AuthBackend {
  const effectiveConfig =
    options.env !== undefined ? applyEnvOverrides(config, options.env) : config;
  const backend = resolveAuthBackendKind(effectiveConfig);
  switch (backend) {
    case "local":
      return new LocalAuthBackend(localBackendOptions(options));
    case "remote":
      return new RemoteAuthBackend(
        remoteBackendOptions(effectiveConfig, options),
      );
  }
}

function localBackendOptions(
  options: AuthBackendSelectionOptions,
): LocalAuthBackendOptions {
  return {
    ...(options.agencHome ? { agencHome: options.agencHome } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
}

function remoteBackendOptions(
  config: Pick<AgenCConfig, "auth">,
  options: AuthBackendSelectionOptions,
): RemoteAuthBackendOptions {
  return {
    ...(options.agencHome ? { agencHome: options.agencHome } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.remote ?? {}),
    managedKeysEnabled: resolveAuthManagedKeysEnabled(config),
  };
}
