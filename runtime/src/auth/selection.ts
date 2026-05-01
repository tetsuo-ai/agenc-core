import type { AgenCConfig, AuthBackendConfigKind } from "../config/schema.js";
import type { EnvSnapshot } from "../config/env.js";
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

export class InvalidAuthBackendConfigError extends Error {
  constructor(value: unknown) {
    super(
      `Invalid auth.backend config: expected "local" or "remote", got ${JSON.stringify(value)}`,
    );
    this.name = "InvalidAuthBackendConfigError";
  }
}

export function resolveAuthBackendKind(
  config: Pick<AgenCConfig, "auth">,
): AuthBackendConfigKind {
  const auth = (config as { readonly auth?: unknown }).auth;
  if (auth === undefined) return "local";
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new InvalidAuthBackendConfigError(auth);
  }
  const backend = (auth as { readonly backend?: unknown }).backend;
  if (backend === undefined) return "local";
  if (backend === "local" || backend === "remote") return backend;
  throw new InvalidAuthBackendConfigError(backend);
}

export function createAuthBackend(
  config: Pick<AgenCConfig, "auth">,
  options: AuthBackendSelectionOptions = {},
): AuthBackend {
  const backend = resolveAuthBackendKind(config);
  switch (backend) {
    case "local":
      return new LocalAuthBackend(localBackendOptions(options));
    case "remote":
      return new RemoteAuthBackend(remoteBackendOptions(options));
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
  options: AuthBackendSelectionOptions,
): RemoteAuthBackendOptions {
  return {
    ...(options.remote ?? {}),
  };
}
