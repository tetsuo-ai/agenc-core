/**
 * Ports the app-server transport auth policy onto AgenC's local daemon peer
 * verification.
 *
 * Why this lives here:
 *   - F-03p owns D-14's verified-peer surface for daemon transports. AgenC's
 *     local Unix socket accepts same-user peer proof when the transport can
 *     provide it, with the shared cookie as the portable authenticator.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Websocket JWT bearer mode and capability-token CLI flags are remote
 *     listener policy; the local daemon socket only needs the private cookie.
 *
 * Reference anchors are tracked in parity evidence, not runtime comments.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { InitializeParams, JsonObject } from "../protocol/index.js";
import type { AuthDaemonSocketIdentity } from "../../auth/backend.js";
import { isRecord } from "../../utils/record.js";

const AGENC_DAEMON_COOKIE_BYTES = 32;
export const AGENC_DAEMON_COOKIE_HEX_LENGTH =
  AGENC_DAEMON_COOKIE_BYTES * 2;
const AGENC_DAEMON_COOKIE_FILE_MODE = 0o600;
const AGENC_DAEMON_COOKIE_DIR_MODE = 0o700;

export class AgenCDaemonCookieAuthenticator {
  readonly #expectedCookie: string;

  constructor(expectedCookie: string) {
    const normalized = normalizeAgenCDaemonCookie(expectedCookie);
    if (normalized === null) {
      throw new Error("AgenC daemon cookie must not be empty");
    }
    this.#expectedCookie = normalized;
  }

  verifyCookie(candidate: string | null | undefined): boolean {
    return verifyAgenCDaemonCookie(candidate, this.#expectedCookie);
  }

  verifyInitializeParams(params: Pick<InitializeParams, "authCookie">): boolean {
    return this.verifyCookie(params.authCookie);
  }

  authenticateInitializeParams(
    params: Pick<InitializeParams, "authCookie">,
  ): AuthDaemonSocketIdentity | null {
    return this.verifyInitializeParams(params)
      ? createAgenCDaemonCookieIdentity()
      : null;
  }

  authenticateInitializeMessage(
    message: JsonObject,
  ): AuthDaemonSocketIdentity | null {
    if (message.method !== "initialize" || !isJsonObject(message.params)) {
      return null;
    }
    const authCookie = message.params.authCookie;
    return this.authenticateInitializeParams({
      authCookie: typeof authCookie === "string" ? authCookie : undefined,
    });
  }
}

export function createAgenCDaemonCookieIdentity(): AuthDaemonSocketIdentity {
  return {
    transport: "daemon",
    verifiedBy: "cookie",
    cookie: "verified",
    peerUid: null,
  };
}

export function createAgenCDaemonPeerUidIdentity(
  peerUid: number,
): AuthDaemonSocketIdentity {
  return {
    transport: "daemon",
    verifiedBy: "peerUid",
    peerUid,
  };
}

export function createAgenCDaemonPrivateSocketOwnerIdentity(
  privateSocketOwnerUid: number,
): AuthDaemonSocketIdentity {
  return {
    transport: "daemon",
    verifiedBy: "privateSocketOwner",
    peerUid: null,
    privateSocketOwnerUid,
  };
}

export async function ensureAgenCDaemonCookie(
  cookiePath: string,
): Promise<string> {
  const cookieDir = dirname(cookiePath);
  await ensurePrivatePathMode(
    cookieDir,
    AGENC_DAEMON_COOKIE_DIR_MODE,
    "AgenC daemon cookie directory",
    async () => {
      await mkdir(cookieDir, {
        recursive: true,
        mode: AGENC_DAEMON_COOKIE_DIR_MODE,
      });
    },
  );

  try {
    await assertRegularCookiePath(cookiePath);
    const existing = normalizeAgenCDaemonCookie(
      await readFile(cookiePath, "utf8"),
    );
    if (existing !== null) {
      await ensurePrivatePathMode(
        cookiePath,
        AGENC_DAEMON_COOKIE_FILE_MODE,
        "AgenC daemon cookie file",
      );
      return existing;
    }
  } catch (error) {
    if (asNodeError(error).code !== "ENOENT") throw error;
  }

  const cookie = randomBytes(AGENC_DAEMON_COOKIE_BYTES).toString("hex");
  return writePrivateCookieFile(cookiePath, cookie);
}

export function verifyAgenCDaemonCookie(
  candidate: string | null | undefined,
  expected: string,
): boolean {
  const normalizedCandidate = normalizeAgenCDaemonCookie(candidate);
  const normalizedExpected = normalizeAgenCDaemonCookie(expected);
  if (normalizedCandidate === null || normalizedExpected === null) {
    return false;
  }

  const candidateBuffer = Buffer.from(normalizedCandidate, "utf8");
  const expectedBuffer = Buffer.from(normalizedExpected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function normalizeAgenCDaemonCookie(
  cookie: string | null | undefined,
): string | null {
  const trimmed = cookie?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

async function assertRegularCookiePath(cookiePath: string): Promise<void> {
  const info = await lstat(cookiePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `AgenC daemon cookie file must be a regular file: ${cookiePath}`,
    );
  }
}

async function writePrivateCookieFile(
  cookiePath: string,
  cookie: string,
): Promise<string> {
  const cookieDir = dirname(cookiePath);
  const tempPath = join(
    cookieDir,
    `.${basename(cookiePath)}.${process.pid}.${randomBytes(8).toString(
      "hex",
    )}.tmp`,
  );
  let tempWritten = false;
  try {
    await writeFile(tempPath, `${cookie}\n`, {
      flag: "wx",
      mode: AGENC_DAEMON_COOKIE_FILE_MODE,
    });
    tempWritten = true;
    await ensurePrivatePathMode(
      tempPath,
      AGENC_DAEMON_COOKIE_FILE_MODE,
      "AgenC daemon temporary cookie file",
    );
    await link(tempPath, cookiePath);
    await assertRegularCookiePath(cookiePath);
    await ensurePrivatePathMode(
      cookiePath,
      AGENC_DAEMON_COOKIE_FILE_MODE,
      "AgenC daemon cookie file",
    );
    return cookie;
  } catch (error) {
    if (asNodeError(error).code !== "EEXIST") throw error;
    const existing = await readExistingPrivateCookie(cookiePath);
    if (existing !== null) return existing;
    return writeEmptyPrivateCookieFile(cookiePath, cookie);
  } finally {
    if (tempWritten) {
      await unlink(tempPath).catch(() => {});
    }
  }
}

async function readExistingPrivateCookie(
  cookiePath: string,
): Promise<string | null> {
  await assertRegularCookiePath(cookiePath);
  await ensurePrivatePathMode(
    cookiePath,
    AGENC_DAEMON_COOKIE_FILE_MODE,
    "AgenC daemon cookie file",
  );
  return normalizeAgenCDaemonCookie(await readFile(cookiePath, "utf8"));
}

async function writeEmptyPrivateCookieFile(
  cookiePath: string,
  cookie: string,
): Promise<string> {
  const existing = await readExistingPrivateCookie(cookiePath);
  if (existing !== null) return existing;
  await writeFile(cookiePath, `${cookie}\n`, { flag: "r+" });
  const written = await readExistingPrivateCookie(cookiePath);
  if (written === null) {
    throw new Error(
      `AgenC daemon cookie file is empty after write: ${cookiePath}`,
    );
  }
  return written;
}

async function ensurePrivatePathMode(
  path: string,
  expectedMode: number,
  label: string,
  create?: () => Promise<void>,
): Promise<void> {
  await create?.();
  await chmod(path, expectedMode);
  if (process.platform === "win32") return;
  const actualMode = (await stat(path)).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `${label} must be mode ${formatMode(expectedMode)}; got ${formatMode(
        actualMode,
      )}`,
    );
  }
}

function formatMode(mode: number): string {
  return `0${mode.toString(8)}`;
}

function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException)
    : new Error(String(error));
}
