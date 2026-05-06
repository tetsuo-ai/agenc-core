import { execFile } from "node:child_process";

export const DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_DEVICE_FLOW_CLIENT_ID_ENV =
  "AGENC_GITHUB_DEVICE_CLIENT_ID";

export const GITHUB_DEVICE_CODE_URL =
  "https://github.com/login/device/code";
export const GITHUB_DEVICE_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_VERIFICATION_URL =
  "https://github.com/login/device";
export const COPILOT_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";

export const DEFAULT_GITHUB_DEVICE_SCOPE = "read:user";
export const DEFAULT_GITHUB_DEVICE_TIMEOUT_SECONDS = 900;
export const DEFAULT_GITHUB_DEVICE_POLL_INTERVAL_SECONDS = 5;

export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
};

export type GitHubDeviceFlowErrorCode =
  | "access_denied"
  | "expired_token"
  | "http_error"
  | "malformed_response"
  | "missing_client_id"
  | "network_error"
  | "oauth_error"
  | "timeout";

export class GitHubDeviceFlowError extends Error {
  readonly code: GitHubDeviceFlowErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      readonly code: GitHubDeviceFlowErrorCode;
      readonly cause?: unknown;
      readonly status?: number;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "GitHubDeviceFlowError";
    this.code = options.code;
    this.status = options.status;
  }
}

export interface GitHubDeviceCodeResult {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface CopilotTokenResponse {
  readonly token: string;
  readonly expires_at: number;
  readonly refresh_in: number;
  readonly endpoints: {
    readonly api: string;
  };
}

export interface GitHubDeviceFlowResult {
  readonly device: GitHubDeviceCodeResult;
  readonly copilotToken: CopilotTokenResponse;
}

type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;
type EnvLike = Readonly<Record<string, string | undefined>>;

export interface GitHubDeviceFlowOptions {
  readonly clientId?: string;
  readonly env?: EnvLike;
  readonly fetchImpl?: FetchLike;
  readonly openBrowser?: boolean;
  readonly openVerificationUri?: (uri: string) => Promise<void>;
  readonly onDeviceCode?: (
    device: GitHubDeviceCodeResult,
  ) => void | Promise<void>;
  readonly scope?: string;
  readonly sleep?: SleepLike;
  readonly timeoutSeconds?: number;
}

export interface RequestGitHubDeviceCodeOptions {
  readonly clientId?: string;
  readonly env?: EnvLike;
  readonly fetchImpl?: FetchLike;
  readonly scope?: string;
}

export interface PollForGitHubAccessTokenOptions {
  readonly clientId?: string;
  readonly env?: EnvLike;
  readonly fetchImpl?: FetchLike;
  readonly initialIntervalSeconds?: number;
  readonly sleep?: SleepLike;
  readonly timeoutSeconds?: number;
}

export function getGitHubDeviceFlowClientId(
  env: EnvLike = process.env,
): string {
  return (
    env[GITHUB_DEVICE_FLOW_CLIENT_ID_ENV]?.trim() ||
    DEFAULT_GITHUB_DEVICE_FLOW_CLIENT_ID
  );
}

export async function startGitHubDeviceFlow(
  options: GitHubDeviceFlowOptions = {},
): Promise<GitHubDeviceFlowResult> {
  const device = await requestGitHubDeviceCode(options);
  await options.onDeviceCode?.(device);

  if (options.openBrowser === true) {
    const opener = options.openVerificationUri ?? openVerificationUri;
    await opener(device.verification_uri);
  }

  const accessToken = await pollForGitHubAccessToken(device.device_code, {
    clientId: options.clientId,
    env: options.env,
    fetchImpl: options.fetchImpl,
    initialIntervalSeconds: device.interval,
    sleep: options.sleep,
    timeoutSeconds: options.timeoutSeconds ?? device.expires_in,
  });
  const copilotToken = await exchangeForCopilotToken(
    accessToken,
    options.fetchImpl,
  );

  return {
    device,
    copilotToken,
  };
}

export async function requestGitHubDeviceCode(
  options: RequestGitHubDeviceCodeOptions = {},
): Promise<GitHubDeviceCodeResult> {
  const clientId = resolveClientId(options.clientId, options.env);
  const requestedScope = trimNonEmpty(options.scope) ?? DEFAULT_GITHUB_DEVICE_SCOPE;
  const scopesToTry =
    requestedScope === DEFAULT_GITHUB_DEVICE_SCOPE
      ? [requestedScope]
      : [requestedScope, DEFAULT_GITHUB_DEVICE_SCOPE];

  let lastError = "Device code request failed.";
  for (const scope of scopesToTry) {
    const response = await fetchGitHub(
      options.fetchImpl,
      GITHUB_DEVICE_CODE_URL,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          scope,
        }),
      },
      "request GitHub device code",
    );

    if (!response.ok) {
      const text = await readResponseText(response);
      lastError = `Device code request failed: ${response.status} ${text}`;
      if (
        scope !== DEFAULT_GITHUB_DEVICE_SCOPE &&
        response.status === 400 &&
        /invalid_scope/i.test(text)
      ) {
        continue;
      }
      throw new GitHubDeviceFlowError(lastError, {
        code: "http_error",
        status: response.status,
      });
    }

    const data = await readJsonObject(response, "device code response");
    const deviceCode = data.device_code;
    const userCode = data.user_code;
    const verificationUri = data.verification_uri;
    if (
      typeof deviceCode !== "string" ||
      deviceCode.length === 0 ||
      typeof userCode !== "string" ||
      userCode.length === 0 ||
      typeof verificationUri !== "string" ||
      verificationUri.length === 0
    ) {
      throw new GitHubDeviceFlowError(
        "Malformed device code response from GitHub",
        { code: "malformed_response" },
      );
    }
    assertGitHubVerificationUri(verificationUri);

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      expires_in:
        typeof data.expires_in === "number"
          ? data.expires_in
          : DEFAULT_GITHUB_DEVICE_TIMEOUT_SECONDS,
      interval:
        typeof data.interval === "number"
          ? data.interval
          : DEFAULT_GITHUB_DEVICE_POLL_INTERVAL_SECONDS,
    };
  }

  throw new GitHubDeviceFlowError(lastError, { code: "http_error" });
}

export async function pollForGitHubAccessToken(
  deviceCode: string,
  options: PollForGitHubAccessTokenOptions = {},
): Promise<string> {
  const clientId = resolveClientId(options.clientId, options.env);
  let intervalSeconds = Math.max(
    1,
    options.initialIntervalSeconds ?? DEFAULT_GITHUB_DEVICE_POLL_INTERVAL_SECONDS,
  );
  const timeoutSeconds = Math.max(
    0,
    options.timeoutSeconds ?? DEFAULT_GITHUB_DEVICE_TIMEOUT_SECONDS,
  );
  const sleep = options.sleep ?? sleepMs;
  const startedAt = Date.now();

  while ((Date.now() - startedAt) / 1000 < timeoutSeconds) {
    const response = await fetchGitHub(
      options.fetchImpl,
      GITHUB_DEVICE_ACCESS_TOKEN_URL,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
      "poll GitHub access token",
    );

    if (!response.ok) {
      const text = await readResponseText(response);
      throw new GitHubDeviceFlowError(
        `Token request failed: ${response.status} ${text}`,
        { code: "http_error", status: response.status },
      );
    }

    const data = await readJsonObject(response, "access token response");
    const error = data.error;
    if (error === undefined || error === null) {
      const token = data.access_token;
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
      throw new GitHubDeviceFlowError("No access_token in response", {
        code: "malformed_response",
      });
    }

    if (error === "authorization_pending") {
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (error === "slow_down") {
      const requestedInterval =
        typeof data.interval === "number"
          ? data.interval
          : intervalSeconds + 5;
      intervalSeconds = Math.max(1, intervalSeconds + 5, requestedInterval);
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (error === "expired_token") {
      throw new GitHubDeviceFlowError(
        "Device code expired. Start the login flow again.",
        { code: "expired_token" },
      );
    }
    if (error === "access_denied") {
      throw new GitHubDeviceFlowError("Authorization was denied or cancelled.", {
        code: "access_denied",
      });
    }

    throw new GitHubDeviceFlowError(`GitHub OAuth error: ${String(error)}`, {
      code: "oauth_error",
    });
  }

  throw new GitHubDeviceFlowError("Timed out waiting for authorization.", {
    code: "timeout",
  });
}

export async function exchangeForCopilotToken(
  oauthToken: string,
  fetchImpl?: FetchLike,
): Promise<CopilotTokenResponse> {
  const response = await fetchGitHub(
    fetchImpl,
    COPILOT_TOKEN_URL,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...COPILOT_HEADERS,
      },
    },
    "exchange GitHub access token for Copilot token",
  );

  if (!response.ok) {
    const text = await readResponseText(response);
    throw new GitHubDeviceFlowError(
      `Copilot token exchange failed: ${response.status} ${text}`,
      { code: "http_error", status: response.status },
    );
  }

  const data = await readJsonObject(response, "Copilot token response");
  const token = data.token;
  const expiresAt = data.expires_at;
  const refreshIn = data.refresh_in;
  const endpoints = data.endpoints;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof expiresAt !== "number" ||
    typeof refreshIn !== "number" ||
    !isRecord(endpoints) ||
    typeof endpoints.api !== "string" ||
    endpoints.api.length === 0
  ) {
    throw new GitHubDeviceFlowError("Malformed Copilot token response", {
      code: "malformed_response",
    });
  }

  return {
    token,
    expires_at: expiresAt,
    refresh_in: refreshIn,
    endpoints: {
      api: endpoints.api,
    },
  };
}

export async function openVerificationUri(uri: string): Promise<void> {
  assertGitHubVerificationUri(uri);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", uri]
      : [uri];

  await new Promise<void>((resolve) => {
    const child = execFile(command, args, { timeout: 5000 }, () => {
      resolve();
    });
    child.unref?.();
  });
}

async function fetchGitHub(
  fetchImpl: FetchLike | undefined,
  input: string,
  init: RequestInit,
  action: string,
): Promise<Response> {
  const fetchFn = fetchImpl ?? fetch;
  try {
    return await fetchFn(input, init);
  } catch (error) {
    throw new GitHubDeviceFlowError(`Failed to ${action}.`, {
      code: "network_error",
      cause: error,
    });
  }
}

async function readJsonObject(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new GitHubDeviceFlowError(`Malformed ${label} from GitHub`, {
      code: "malformed_response",
      cause: error,
    });
  }
  if (!isRecord(data)) {
    throw new GitHubDeviceFlowError(`Malformed ${label} from GitHub`, {
      code: "malformed_response",
    });
  }
  return data;
}

async function readResponseText(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

function resolveClientId(clientId: string | undefined, env?: EnvLike): string {
  const resolved = trimNonEmpty(clientId) ?? getGitHubDeviceFlowClientId(env);
  if (resolved.length === 0) {
    throw new GitHubDeviceFlowError(
      `No OAuth client ID: set ${GITHUB_DEVICE_FLOW_CLIENT_ID_ENV}.`,
      { code: "missing_client_id" },
    );
  }
  return resolved;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertGitHubVerificationUri(uri: string): void {
  if (!isGitHubVerificationUri(uri)) {
    throw new GitHubDeviceFlowError(
      "Malformed device code response from GitHub",
      { code: "malformed_response" },
    );
  }
}

export function isGitHubVerificationUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.pathname.replace(/\/+$/, "") === "/login/device" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}
