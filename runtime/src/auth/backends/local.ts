import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EnvSnapshot } from "../../config/env.js";
import type { HomeContext } from "../../config/home.js";
import { normalizeProviderIdentity } from "../../provider-identity.js";
import {
  clearLocalLoginCredential,
  readLocalByokCredential,
  readLocalLoginCredential,
  rollbackLocalLoginCredential,
  storeLocalByokCredential,
  storeLocalLoginCredential,
} from "../native-credentials.js";
import type { NativeSecureStorageTransaction } from "../../utils/secureStorage/native.js";
import { captureSecureStorageIngress } from "../../utils/secureStorage/home.js";
import type {
  AuthBackend,
  AuthInferAgencModelParams,
  AuthInferredAgencModel,
  AuthLoginParams,
  AuthLoginResult,
  AuthLogoutParams,
  AuthLogoutResult,
  AuthLlmUsage,
  AuthProviderSlug,
  AuthSessionId,
  AuthSessionRef,
  AuthSubscriptionTier,
  AuthVendedCredential,
  AuthWhoamiParams,
  AuthWhoamiResult,
} from "../backend.js";

const LOCAL_AUTH_STATE_FILENAME = "auth.json" as const;
const LOCAL_AUTH_STATE_VERSION = 1 as const;

interface LocalAuthDiskState {
  readonly version: typeof LOCAL_AUTH_STATE_VERSION;
  readonly createdAt: string;
  readonly provider: "local";
  readonly identity: {
    readonly accountId: string;
    readonly displayName: string;
    readonly plan: AuthSubscriptionTier;
  };
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
  private readonly home: HomeContext;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: LocalAuthBackendOptions = {}) {
    this.home = captureSecureStorageIngress(
      options.env ?? process.env,
      options.agencHome,
    ).home;
    this.authFilePath = join(this.home.path, LOCAL_AUTH_STATE_FILENAME);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID;
  }

  authFile(): string {
    return this.authFilePath;
  }

  async login(_params: AuthLoginParams = {}): Promise<LocalAuthLoginResult> {
    const createdAt = this.now().toISOString();
    const token = this.randomUUID();
    const state = this.createDiskState(createdAt);
    const credentialTransaction = storeLocalLoginCredential(this.home, {
      token,
      createdAt,
    });
    try {
      await writeLocalAuthState(this.authFilePath, state);
    } catch (error) {
      rollbackLocalLoginAfterStateFailure(
        this.home,
        credentialTransaction,
        error,
      );
    }
    return {
      authenticated: true,
      provider: "local",
      token,
      identity: state.identity,
    };
  }

  async logout(_params: AuthLogoutParams = {}): Promise<AuthLogoutResult> {
    const credentialTransaction = clearLocalLoginCredential(this.home);
    try {
      await rm(this.authFilePath, { force: true });
    } catch (error) {
      rollbackLocalLoginAfterStateFailure(
        this.home,
        credentialTransaction,
        error,
      );
    }
    return { authenticated: false };
  }

  async whoami(
    _params: AuthWhoamiParams = {},
  ): Promise<LocalAuthWhoamiResult> {
    const state = await readLocalAuthState(this.authFilePath);
    const credential = readLocalLoginCredential(this.home);
    if (!state || credential?.createdAt !== state.createdAt) {
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
    const provider = providerCredentialIdentity(params.provider);
    const apiKey = normalizeApiKey(params.apiKey);
    const record: LocalByokKeyRecord = {
      provider,
      apiKey,
      savedAt: this.now().toISOString(),
    };
    storeLocalByokCredential(this.home, provider, record);
    return record;
  }

  async readByokKey(
    provider: AuthProviderSlug | string,
  ): Promise<string | undefined> {
    const normalizedProvider = providerCredentialIdentity(provider);
    const apiKey = readLocalByokCredential(
      this.home,
      normalizedProvider,
    )?.apiKey;
    return typeof apiKey === "string" && apiKey.trim().length > 0
      ? apiKey
      : undefined;
  }

  vendKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): AuthVendedCredential {
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

  getLlmUsage(
    _params: AuthSessionRef = {},
  ): AuthLlmUsage {
    return {
      managedModelsEnabled: false,
      modelAllowance: {
        allowedModelCount: 0,
        duration: "30d",
        includedUsd: 0,
        percentUsed: 0,
        remainingUsd: 0,
        status: "free",
        usedUsd: 0,
      },
      subscriptionTier: "free",
    };
  }

  private createDiskState(createdAt: string): LocalAuthDiskState {
    return {
      version: LOCAL_AUTH_STATE_VERSION,
      createdAt,
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    };
  }
}

function isLocalAuthDiskState(value: unknown): value is LocalAuthDiskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LocalAuthDiskState>;
  return (
    state.version === LOCAL_AUTH_STATE_VERSION &&
    typeof state.createdAt === "string" &&
    state.provider === "local" &&
    isLocalAuthIdentity(state.identity)
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

function providerCredentialIdentity(provider: AuthProviderSlug | string): string {
  const normalized = normalizeProviderIdentity(
    provider,
    "local provider credential",
  );
  if (normalized === undefined) {
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

function rollbackLocalLoginAfterStateFailure(
  home: HomeContext,
  transaction: NativeSecureStorageTransaction | null,
  stateError: unknown,
): never {
  try {
    rollbackLocalLoginCredential(home, transaction);
  } catch (rollbackError) {
    throw new AggregateError(
      [stateError, rollbackError],
      "Local authentication state write failed and its credential rollback did not complete",
    );
  }
  throw stateError;
}
