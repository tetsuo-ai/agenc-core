import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  resolveAgencHome,
  type EnvSnapshot,
} from "../../config/env.js";
import type {
  AuthBackend,
  AuthInferAgencModelParams,
  AuthInferredAgencModel,
  AuthLoginParams,
  AuthLoginResult,
  AuthLogoutParams,
  AuthLogoutResult,
  AuthProviderSlug,
  AuthSessionId,
  AuthSessionRef,
  AuthSubscriptionTier,
  AuthVendedKey,
  AuthWhoamiParams,
  AuthWhoamiResult,
} from "../backend.js";

const LOCAL_AUTH_STATE_FILENAME = "auth.json" as const;
const LOCAL_BYOK_STATE_FILENAME = "byok-keys.json" as const;
const LOCAL_AUTH_STATE_VERSION = 1 as const;

interface LocalAuthDiskState {
  readonly version: typeof LOCAL_AUTH_STATE_VERSION;
  readonly token: string;
  readonly createdAt: string;
  readonly provider: "local";
  readonly identity: {
    readonly accountId: string;
    readonly displayName: string;
    readonly plan: AuthSubscriptionTier;
  };
  readonly byokKeys?: Readonly<Record<string, LocalByokKeyRecord>>;
}

interface LocalByokDiskState {
  readonly version: typeof LOCAL_AUTH_STATE_VERSION;
  readonly byokKeys: Readonly<Record<string, LocalByokKeyRecord>>;
}

export interface LocalAuthBackendOptions {
  readonly agencHome?: string;
  readonly env?: EnvSnapshot;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface LocalAuthLoginResult extends AuthLoginResult {
  readonly provider: "local";
  readonly token: string;
  readonly identity: LocalAuthDiskState["identity"];
}

export interface LocalAuthWhoamiResult extends AuthWhoamiResult {
  readonly provider?: "local";
  readonly identity?: LocalAuthDiskState["identity"];
}

export interface LocalByokKeyRecord {
  readonly provider: string;
  readonly apiKey: string;
  readonly savedAt: string;
}

export interface SaveLocalByokKeyParams {
  readonly provider: string;
  readonly apiKey: string;
}

export class LocalAuthBackend implements AuthBackend {
  readonly kind = "local";

  private readonly authFilePath: string;
  private readonly byokFilePath: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: LocalAuthBackendOptions = {}) {
    const agencHome =
      options.agencHome ?? resolveAgencHome(options.env ?? process.env);
    this.authFilePath = join(agencHome, LOCAL_AUTH_STATE_FILENAME);
    this.byokFilePath = join(agencHome, LOCAL_BYOK_STATE_FILENAME);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID;
  }

  authFile(): string {
    return this.authFilePath;
  }

  async login(_params: AuthLoginParams = {}): Promise<LocalAuthLoginResult> {
    const current = await readLocalAuthState(this.authFilePath);
    const byok = await readLocalByokState(this.byokFilePath);
    const state: LocalAuthDiskState = {
      ...this.createDiskState(),
      ...(current?.byokKeys !== undefined || byok?.byokKeys !== undefined
        ? {
            byokKeys: {
              ...(current?.byokKeys ?? {}),
              ...(byok?.byokKeys ?? {}),
            },
          }
        : {}),
    };
    await writeLocalAuthState(this.authFilePath, state);
    return {
      authenticated: true,
      provider: "local",
      token: state.token,
      identity: state.identity,
    };
  }

  async logout(_params: AuthLogoutParams = {}): Promise<AuthLogoutResult> {
    await rm(this.authFilePath, { force: true });
    return { authenticated: false };
  }

  async whoami(
    _params: AuthWhoamiParams = {},
  ): Promise<LocalAuthWhoamiResult> {
    const state = await readLocalAuthState(this.authFilePath);
    if (!state) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      provider: "local",
      identity: state.identity,
    };
  }

  async saveByokKey(
    params: SaveLocalByokKeyParams,
  ): Promise<LocalByokKeyRecord> {
    const provider = normalizeProviderKey(params.provider);
    const apiKey = normalizeApiKey(params.apiKey);
    const current = await readLocalAuthState(this.authFilePath);
    const currentByok = await readLocalByokState(this.byokFilePath);
    const record: LocalByokKeyRecord = {
      provider,
      apiKey,
      savedAt: this.now().toISOString(),
    };
    const byokKeys = {
      ...(current?.byokKeys ?? {}),
      ...(currentByok?.byokKeys ?? {}),
      [provider]: record,
    };
    await writeLocalByokState(this.byokFilePath, {
      version: LOCAL_AUTH_STATE_VERSION,
      byokKeys,
    });
    if (current !== null) {
      await writeLocalAuthState(this.authFilePath, {
        ...current,
        byokKeys,
      });
    }
    return record;
  }

  async readByokKey(
    provider: AuthProviderSlug | string,
  ): Promise<string | undefined> {
    const normalizedProvider = normalizeProviderKey(provider);
    const byokState = await readLocalByokState(this.byokFilePath);
    const byokApiKey = byokState?.byokKeys?.[normalizedProvider]?.apiKey;
    if (typeof byokApiKey === "string" && byokApiKey.trim().length > 0) {
      return byokApiKey;
    }
    const state = await readLocalAuthState(this.authFilePath);
    const apiKey = state?.byokKeys?.[normalizedProvider]?.apiKey;
    return typeof apiKey === "string" && apiKey.trim().length > 0
      ? apiKey
      : undefined;
  }

  vendKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): AuthVendedKey {
    throw new Error(
      `LocalAuthBackend cannot vend managed keys for provider "${provider}" in session "${sessionId}"; use BYOK fallback`,
    );
  }

  inferAgencModel(
    _params: AuthInferAgencModelParams = {},
  ): AuthInferredAgencModel {
    throw new Error(
      "LocalAuthBackend cannot infer hosted AgenC models; use configured BYOK provider/model selection",
    );
  }

  getSubscriptionTier(
    _params: AuthSessionRef = {},
  ): AuthSubscriptionTier {
    return "free";
  }

  private createDiskState(): LocalAuthDiskState {
    return {
      version: LOCAL_AUTH_STATE_VERSION,
      token: this.randomUUID(),
      createdAt: this.now().toISOString(),
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    };
  }
}

function isLocalByokDiskState(value: unknown): value is LocalByokDiskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LocalByokDiskState>;
  return (
    state.version === LOCAL_AUTH_STATE_VERSION &&
    state.byokKeys !== undefined &&
    isLocalByokKeys(state.byokKeys)
  );
}

function isLocalAuthDiskState(value: unknown): value is LocalAuthDiskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LocalAuthDiskState>;
  return (
    state.version === LOCAL_AUTH_STATE_VERSION &&
    typeof state.token === "string" &&
    state.token.length > 0 &&
    typeof state.createdAt === "string" &&
    state.provider === "local" &&
    isLocalAuthIdentity(state.identity) &&
    isLocalByokKeys(state.byokKeys)
  );
}

function isLocalAuthIdentity(
  value: unknown,
): value is LocalAuthDiskState["identity"] {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<LocalAuthDiskState["identity"]>;
  return (
    identity.accountId === "local" &&
    typeof identity.displayName === "string" &&
    identity.plan === "free"
  );
}

function isLocalByokKeys(
  value: unknown,
): value is Readonly<Record<string, LocalByokKeyRecord>> | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, record]) =>
    isNormalizedProviderKey(key) && isLocalByokKeyRecord(record)
  );
}

function isLocalByokKeyRecord(value: unknown): value is LocalByokKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalByokKeyRecord>;
  return (
    typeof record.provider === "string" &&
    isNormalizedProviderKey(record.provider) &&
    typeof record.apiKey === "string" &&
    record.apiKey.trim().length > 0 &&
    !/\s/.test(record.apiKey) &&
    typeof record.savedAt === "string"
  );
}

function isNormalizedProviderKey(provider: string): boolean {
  return (
    provider.length > 0 &&
    provider.trim().toLowerCase() === provider &&
    !/\s/.test(provider)
  );
}

async function readLocalAuthState(
  path: string,
): Promise<LocalAuthDiskState | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isLocalAuthDiskState(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function readLocalByokState(
  path: string,
): Promise<LocalByokDiskState | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isLocalByokDiskState(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function normalizeProviderKey(provider: AuthProviderSlug | string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("provider is required to save a BYOK key");
  }
  return normalized;
}

function normalizeApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new Error("API key is required");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("API key must not contain whitespace");
  }
  return trimmed;
}

async function writeLocalAuthState(
  path: string,
  state: LocalAuthDiskState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

async function writeLocalByokState(
  path: string,
  state: LocalByokDiskState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}
