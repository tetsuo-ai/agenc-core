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

export const LOCAL_AUTH_STATE_FILENAME = "auth.json" as const;
export const LOCAL_AUTH_STATE_VERSION = 1 as const;

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

export class LocalAuthBackend implements AuthBackend {
  readonly kind = "local";

  private readonly authFilePath: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: LocalAuthBackendOptions = {}) {
    const agencHome =
      options.agencHome ?? resolveAgencHome(options.env ?? process.env);
    this.authFilePath = join(agencHome, LOCAL_AUTH_STATE_FILENAME);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? cryptoRandomUUID;
  }

  authFile(): string {
    return this.authFilePath;
  }

  async login(_params: AuthLoginParams = {}): Promise<LocalAuthLoginResult> {
    const token = this.randomUUID();
    const state: LocalAuthDiskState = {
      version: LOCAL_AUTH_STATE_VERSION,
      token,
      createdAt: this.now().toISOString(),
      provider: "local",
      identity: {
        accountId: "local",
        displayName: "Local AgenC user",
        plan: "free",
      },
    };
    await writeLocalAuthState(this.authFilePath, state);
    return {
      authenticated: true,
      provider: "local",
      token,
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
