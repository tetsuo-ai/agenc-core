/**
 * Codex CLI OAuth credential loading and refresh helpers.
 *
 * Mirrors the Codex CLI's local credential contract closely enough for the
 * runtime to reuse ChatGPT OAuth credentials without owning the login flow.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { LLMAuthenticationError, LLMProviderError } from "../errors.js";

const PROVIDER_NAME = "codex";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

interface CodexTokenData {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
  [key: string]: unknown;
}

interface CodexAuthJson {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: CodexTokenData | null;
  last_refresh?: unknown;
  [key: string]: unknown;
}

interface CodexAuthTokenState {
  readonly auth: CodexAuthJson;
  readonly tokens: CodexTokenData;
  readonly accessToken: string;
  readonly refreshToken: string;
}

interface RefreshResponse {
  readonly id_token?: unknown;
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly account_id?: unknown;
}

interface CodexIdTokenInfo {
  readonly accountId?: string;
  readonly isFedrampAccount: boolean;
}

export interface CodexOAuthCredentialManagerConfig {
  readonly codexHome?: string;
  readonly codexAuthPath?: string;
  readonly refreshTokenUrl?: string;
}

export interface CodexOAuthCredentialHeaders {
  readonly accessToken: string;
  readonly headers: Readonly<Record<string, string>>;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 3 || !parts[1]) return undefined;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractJwtExpiryMs(jwt: string): number | undefined {
  const payload = decodeJwtPayload(jwt);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

function parseDateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractAuthClaims(idToken: unknown): Record<string, unknown> | undefined {
  if (typeof idToken === "string") {
    const payload = decodeJwtPayload(idToken);
    const claims = payload?.["https://api.openai.com/auth"];
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  }
  if (idToken && typeof idToken === "object" && !Array.isArray(idToken)) {
    return idToken as Record<string, unknown>;
  }
  return undefined;
}

function extractIdTokenInfo(tokens: CodexTokenData): CodexIdTokenInfo {
  const claims = extractAuthClaims(tokens.id_token);
  const accountIdFromClaim = normalizeString(claims?.chatgpt_account_id);
  const isFedrampAccount = claims?.chatgpt_account_is_fedramp === true;
  return {
    accountId: normalizeString(tokens.account_id) ?? accountIdFromClaim,
    isFedrampAccount,
  };
}

function isChatGptAuthMode(authMode: unknown): boolean {
  const normalized = normalizeString(authMode)?.toLowerCase();
  if (!normalized) return false;
  return normalized.includes("chatgpt") || normalized.includes("chat-gpt");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRefreshTokenUrl(configured?: string): string {
  return (
    normalizeString(configured) ??
    normalizeString(process.env[REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR]) ??
    DEFAULT_REFRESH_TOKEN_URL
  );
}

export function resolveCodexAuthPath(
  config: Pick<CodexOAuthCredentialManagerConfig, "codexHome" | "codexAuthPath">,
): string {
  const explicitPath = normalizeString(config.codexAuthPath);
  if (explicitPath) return explicitPath;
  const codexHome =
    normalizeString(config.codexHome) ??
    normalizeString(process.env.CODEX_HOME) ??
    join(homedir(), ".codex");
  return join(codexHome, "auth.json");
}

export class CodexOAuthCredentialManager {
  private readonly authPath: string;
  private readonly refreshTokenUrl: string;

  constructor(config: CodexOAuthCredentialManagerConfig = {}) {
    this.authPath = resolveCodexAuthPath(config);
    this.refreshTokenUrl = getRefreshTokenUrl(config.refreshTokenUrl);
  }

  async getAuthHeaders(): Promise<CodexOAuthCredentialHeaders> {
    const state = await this.loadAuthState();
    const activeState = this.needsRefresh(state.auth, state.accessToken)
      ? await this.refreshAndPersist(state)
      : state;
    const tokenInfo = extractIdTokenInfo(activeState.tokens);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${activeState.accessToken}`,
    };
    if (tokenInfo.accountId) {
      headers["ChatGPT-Account-ID"] = tokenInfo.accountId;
    }
    if (tokenInfo.isFedrampAccount) {
      headers["X-OpenAI-Fedramp"] = "true";
    }
    return {
      accessToken: activeState.accessToken,
      headers,
    };
  }

  private async loadAuthState(): Promise<CodexAuthTokenState> {
    let raw: string;
    try {
      raw = await readFile(this.authPath, "utf8");
    } catch (error) {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Could not read Codex OAuth credentials at ${this.authPath}. Run the Codex CLI login flow first, then point llm.codexHome or llm.codexAuthPath at that credential store. Cause: ${(error as Error).message}`,
        401,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Codex OAuth credentials at ${this.authPath} are not valid JSON.`,
        401,
      );
    }
    if (!isRecord(parsed)) {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Codex OAuth credentials at ${this.authPath} must be a JSON object.`,
        401,
      );
    }
    const auth = parsed as CodexAuthJson;
    const tokens = auth.tokens;
    const hasChatGptMode = isChatGptAuthMode(auth.auth_mode);
    if (!isRecord(tokens)) {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Codex credentials at ${this.authPath} do not contain ChatGPT OAuth tokens. Run Codex CLI and choose ChatGPT sign-in instead of API-key auth.`,
        401,
      );
    }

    const accessToken = normalizeString(tokens.access_token);
    const refreshToken = normalizeString(tokens.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Codex credentials at ${this.authPath} are missing access_token or refresh_token values.`,
        401,
      );
    }
    if (!hasChatGptMode && typeof auth.OPENAI_API_KEY === "string") {
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Codex credentials at ${this.authPath} are API-key based. OpenAI Codex OAuth requires ChatGPT OAuth tokens from the Codex CLI login flow.`,
        401,
      );
    }

    return {
      auth,
      tokens,
      accessToken,
      refreshToken,
    };
  }

  private needsRefresh(auth: CodexAuthJson, accessToken: string): boolean {
    const nowMs = Date.now();
    const accessTokenExpiresAt = extractJwtExpiryMs(accessToken);
    if (accessTokenExpiresAt !== undefined) {
      return accessTokenExpiresAt <= nowMs + ACCESS_TOKEN_EXPIRY_SKEW_MS;
    }
    const lastRefreshMs = parseDateMs(auth.last_refresh);
    if (lastRefreshMs === undefined) return true;
    return lastRefreshMs <= nowMs - TOKEN_REFRESH_INTERVAL_MS;
  }

  private async refreshAndPersist(
    state: CodexAuthTokenState,
  ): Promise<CodexAuthTokenState> {
    const response = await fetch(this.refreshTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: state.refreshToken,
      }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new LLMAuthenticationError(PROVIDER_NAME, response.status);
      }
      throw new LLMProviderError(
        PROVIDER_NAME,
        `Failed to refresh Codex OAuth token at ${this.refreshTokenUrl} (HTTP ${response.status}).`,
        response.status,
      );
    }

    const body = (await response.json()) as RefreshResponse;
    const nextAccessToken = normalizeString(body.access_token);
    const nextRefreshToken = normalizeString(body.refresh_token);
    if (!nextAccessToken || !nextRefreshToken) {
      throw new LLMProviderError(
        PROVIDER_NAME,
        "Codex OAuth refresh response did not include access_token and refresh_token.",
        502,
      );
    }

    const nextTokens: CodexTokenData = {
      ...state.tokens,
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
      ...(body.id_token !== undefined ? { id_token: body.id_token } : {}),
    };
    const refreshedIdTokenInfo = extractIdTokenInfo({
      ...nextTokens,
      account_id: undefined,
    });
    const accountId =
      normalizeString(body.account_id) ??
      refreshedIdTokenInfo.accountId ??
      normalizeString(nextTokens.account_id);
    if (accountId) {
      nextTokens.account_id = accountId;
    }

    const nextAuth: CodexAuthJson = {
      ...state.auth,
      tokens: nextTokens,
      last_refresh: new Date().toISOString(),
    };
    await this.persistAuth(nextAuth);
    return {
      auth: nextAuth,
      tokens: nextTokens,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
    };
  }

  private async persistAuth(auth: CodexAuthJson): Promise<void> {
    await mkdir(dirname(this.authPath), { recursive: true });
    const tmpPath = `${this.authPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmpPath, this.authPath);
    await chmod(this.authPath, 0o600).catch(() => undefined);
  }
}
