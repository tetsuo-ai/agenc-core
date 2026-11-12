import type { HomeContext } from "../config/home.js";
import {
  resolveGeneratedSurfaceToken,
  type GeneratedSurfaceTokenSlot,
} from "../utils/secureStorage/generatedToken.js";
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from "../utils/secureStorage/native.js";

export const GATEWAY_CREDENTIAL_ENV_NAMES = Object.freeze([
  "AGENC_GATEWAY_HELIUS_API_KEY",
  "AGENC_TELEGRAM_BOT_TOKEN",
  "AGENC_TELEGRAM_OWNER_CLAIM_CODE",
  "AGENC_WEBCHAT_TOKEN",
  "AGENC_DISCORD_BOT_TOKEN",
  "AGENC_SLACK_BOT_TOKEN",
  "AGENC_SLACK_APP_TOKEN",
  "AGENC_HOOKS_TOKEN",
] as const);

export type GatewayCredentialEnvironmentName =
  (typeof GATEWAY_CREDENTIAL_ENV_NAMES)[number];

const GATEWAY_CREDENTIAL_ENV_NAME_SET: ReadonlySet<string> = new Set(
  GATEWAY_CREDENTIAL_ENV_NAMES,
);

export type GatewayGeneratedTokenName = "hooks" | "webchat";

export interface GatewayCredentialSnapshot {
  readonly environment: Readonly<Record<string, string>>;
  readonly generatedTokens: Readonly<
    Partial<Record<GatewayGeneratedTokenName, string>>
  >;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readGatewayCredentialEnvironment(
  home: HomeContext,
): Readonly<Record<string, string>> {
  return readGatewayCredentialSnapshot(home).environment;
}

/** Read both gateway credential namespaces from one secure-storage snapshot. */
export function readGatewayCredentialSnapshot(
  home: HomeContext,
): GatewayCredentialSnapshot {
  const gateway = readNativeSecureStorage(home).gateway;
  return Object.freeze({
    environment: Object.freeze({ ...(gateway?.environment ?? {}) }),
    generatedTokens: Object.freeze({ ...(gateway?.generatedTokens ?? {}) }),
  });
}

export function mergeGatewayCredentialEnvironment(
  home: HomeContext,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...readGatewayCredentialEnvironment(home), ...environment };
}

export function updateGatewayCredentialEnvironment(
  home: HomeContext,
  entries: Readonly<Record<string, string>>,
): void {
  const normalized: Record<string, string> = {};
  for (const [name, raw] of Object.entries(entries)) {
    if (!GATEWAY_CREDENTIAL_ENV_NAME_SET.has(name)) {
      throw new Error(
        `${name} is not a gateway credential; persistent non-secret settings belong in config.toml`,
      );
    }
    const value = nonEmpty(raw);
    if (value === undefined) {
      throw new Error(`${name} must be a non-empty credential`);
    }
    normalized[name] = value;
  }
  updateNativeSecureStorage(
    home,
    (current) => ({
      ...current,
      gateway: {
        ...current.gateway,
        environment: {
          ...current.gateway?.environment,
          ...normalized,
        },
      },
    }),
    "Native secure storage is required to save gateway credentials",
  );
}

export function readGatewayGeneratedToken(
  home: HomeContext,
  name: GatewayGeneratedTokenName,
): string | undefined {
  return nonEmpty(readGatewayCredentialSnapshot(home).generatedTokens[name]);
}

function gatewayGeneratedTokenSlot(
  name: GatewayGeneratedTokenName,
): GeneratedSurfaceTokenSlot {
  return {
    read: (current) => current.gateway?.generatedTokens?.[name],
    write: (current, token) => ({
      ...current,
      gateway: {
        ...current.gateway,
        generatedTokens: {
          ...current.gateway?.generatedTokens,
          [name]: token,
        },
      },
    }),
    unavailableMessage:
      "Native secure storage is required for gateway surface tokens",
  };
}

export function resolveGatewayGeneratedToken(
  home: HomeContext,
  name: GatewayGeneratedTokenName,
  environmentValue: string | undefined,
): string {
  return resolveGeneratedSurfaceToken(
    home,
    gatewayGeneratedTokenSlot(name),
    environmentValue,
  );
}
