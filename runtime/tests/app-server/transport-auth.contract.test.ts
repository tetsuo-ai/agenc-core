import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgenCDaemonCookieAuthenticator,
  AGENC_DAEMON_COOKIE_HEX_LENGTH,
  createAgenCDaemonCookieIdentity,
  createAgenCDaemonPrivateSocketOwnerIdentity,
  createAgenCDaemonPeerUidIdentity,
  ensureAgenCDaemonCookie,
  normalizeAgenCDaemonCookie,
  verifyAgenCDaemonCookie,
} from "./transport/auth.js";

async function tempAgencHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-transport-auth-"));
}

describe("AgenC daemon transport authentication", () => {
  it("creates and reuses a private daemon cookie", async () => {
    const agencHome = await tempAgencHome();
    const cookiePath = join(agencHome, "daemon.cookie");
    try {
      const first = await ensureAgenCDaemonCookie(cookiePath);
      const second = await ensureAgenCDaemonCookie(cookiePath);
      const mode = (await stat(cookiePath)).mode & 0o777;

      expect(first).toHaveLength(AGENC_DAEMON_COOKIE_HEX_LENGTH);
      expect(second).toBe(first);
      expect((await readFile(cookiePath, "utf8")).trim()).toBe(first);
      expect(mode).toBe(0o600);
      expect((await stat(agencHome)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("repairs permissions when reusing an existing cookie", async () => {
    const agencHome = await tempAgencHome();
    const cookiePath = join(agencHome, "daemon.cookie");
    try {
      await chmod(agencHome, 0o755);
      await writeFile(cookiePath, "existing-cookie\n", { mode: 0o644 });

      await expect(ensureAgenCDaemonCookie(cookiePath)).resolves.toBe(
        "existing-cookie",
      );
      expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
      expect((await stat(agencHome)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("secures an existing empty cookie file before writing a new cookie", async () => {
    const agencHome = await tempAgencHome();
    const cookiePath = join(agencHome, "daemon.cookie");
    try {
      await mkdir(agencHome, { recursive: true, mode: 0o755 });
      await chmod(agencHome, 0o755);
      await writeFile(cookiePath, "\n", { mode: 0o644 });

      const cookie = await ensureAgenCDaemonCookie(cookiePath);
      expect(cookie).toHaveLength(AGENC_DAEMON_COOKIE_HEX_LENGTH);
      expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
      expect((await stat(agencHome)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("reuses the winning cookie when first-time creation races", async () => {
    const agencHome = await tempAgencHome();
    const cookiePath = join(agencHome, "daemon.cookie");
    try {
      const cookies = await Promise.all(
        Array.from({ length: 8 }, () => ensureAgenCDaemonCookie(cookiePath)),
      );
      const uniqueCookies = new Set(cookies);

      expect(uniqueCookies.size).toBe(1);
      expect((await readFile(cookiePath, "utf8")).trim()).toBe(cookies[0]);
      expect((await stat(cookiePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  (process.platform === "win32" ? it.skip : it)(
    "rejects symbolic-link cookie paths",
    async () => {
      const agencHome = await tempAgencHome();
      const cookiePath = join(agencHome, "daemon.cookie");
      const targetPath = join(agencHome, "target.cookie");
      try {
        await writeFile(targetPath, "target-cookie\n", { mode: 0o600 });
        await symlink(targetPath, cookiePath);

        await expect(ensureAgenCDaemonCookie(cookiePath)).rejects.toThrow(
          /regular file/,
        );
        await expect(readFile(targetPath, "utf8")).resolves.toBe(
          "target-cookie\n",
        );
      } finally {
        await rm(agencHome, { recursive: true, force: true });
      }
    },
  );

  it("normalizes and verifies initialize cookies", () => {
    expect(normalizeAgenCDaemonCookie("  socket-cookie\n")).toBe(
      "socket-cookie",
    );
    expect(normalizeAgenCDaemonCookie("   ")).toBeNull();
    expect(verifyAgenCDaemonCookie("socket-cookie", "socket-cookie")).toBe(
      true,
    );
    expect(verifyAgenCDaemonCookie("wrong-cookie", "socket-cookie")).toBe(
      false,
    );
    expect(verifyAgenCDaemonCookie("rocket-cookie", "socket-cookie")).toBe(
      false,
    );
    expect(verifyAgenCDaemonCookie(undefined, "socket-cookie")).toBe(false);
    expect(verifyAgenCDaemonCookie("short", "socket-cookie")).toBe(false);

    const authenticator = new AgenCDaemonCookieAuthenticator("socket-cookie");
    expect(
      authenticator.verifyInitializeParams({ authCookie: "socket-cookie" }),
    ).toBe(true);
    expect(
      authenticator.authenticateInitializeParams({
        authCookie: "socket-cookie",
      }),
    ).toEqual(createAgenCDaemonCookieIdentity());
    expect(
      authenticator.authenticateInitializeMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { authCookie: "socket-cookie" },
      }),
    ).toEqual(createAgenCDaemonCookieIdentity());
    expect(
      authenticator.authenticateInitializeMessage({
        jsonrpc: "2.0",
        id: "agent-list",
        method: "agent.list",
        params: { authCookie: "socket-cookie" },
      }),
    ).toBeNull();
    expect(createAgenCDaemonPeerUidIdentity(1000)).toEqual({
      transport: "daemon",
      verifiedBy: "peerUid",
      peerUid: 1000,
    });
    expect(createAgenCDaemonPrivateSocketOwnerIdentity(1000)).toEqual({
      transport: "daemon",
      verifiedBy: "privateSocketOwner",
      peerUid: null,
      privateSocketOwnerUid: 1000,
    });
    expect(
      authenticator.verifyInitializeParams({ authCookie: "wrong-cookie" }),
    ).toBe(false);
    expect(
      authenticator.authenticateInitializeParams({ authCookie: "wrong-cookie" }),
    ).toBeNull();
    expect(authenticator.verifyInitializeParams([] as never)).toBe(false);
    expect(
      authenticator.authenticateInitializeMessage({
        jsonrpc: "2.0",
        id: "array-params",
        method: "initialize",
        params: [] as never,
      }),
    ).toBeNull();
  });

  it("rejects empty expected cookies", () => {
    expect(() => new AgenCDaemonCookieAuthenticator(" ")).toThrow(
      "AgenC daemon cookie must not be empty",
    );
  });
});
