import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  vi.resetModules();
  resetEnv();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  resetEnv();
  vi.resetModules();
});

describe("remote token path resolution", () => {
  it("reads remote tokens from HOME by default", async () => {
    const home = await tempHomeWithToken("home-token");
    process.env.HOME = home;

    const auth = await loadAuthFileDescriptor();

    expect(auth.CCR_OAUTH_TOKEN_PATH).toBe(join(home, ".agenc", "remote", ".oauth_token"));
    expect(auth.getOAuthTokenFromFileDescriptor()).toBe("home-token");
  });

  it("prefers an absolute AGENC_REMOTE_TOKEN_DIR override", async () => {
    const home = await tempHomeWithToken("home-token");
    const override = await tempTokenDirWithToken("override-token");
    process.env.HOME = home;
    process.env.AGENC_REMOTE_TOKEN_DIR = override;

    const auth = await loadAuthFileDescriptor();

    expect(auth.CCR_OAUTH_TOKEN_PATH).toBe(join(override, ".oauth_token"));
    expect(auth.getOAuthTokenFromFileDescriptor()).toBe("override-token");
  });

  it("falls back to HOME for blank or relative token-dir overrides", async () => {
    const home = await tempHomeWithToken("home-token");
    process.env.HOME = home;
    process.env.AGENC_REMOTE_TOKEN_DIR = " relative-token-dir ";

    const auth = await loadAuthFileDescriptor();

    expect(auth.CCR_OAUTH_TOKEN_PATH).toBe(join(home, ".agenc", "remote", ".oauth_token"));
    expect(auth.getOAuthTokenFromFileDescriptor()).toBe("home-token");
  });

  it("fails closed instead of writing secrets under cwd when HOME is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agenc-remote-token-cwd-"));
    delete process.env.HOME;
    delete process.env.AGENC_REMOTE_TOKEN_DIR;
    process.env.AGENC_REMOTE = "1";
    process.chdir(cwd);

    const auth = await loadAuthFileDescriptor();

    expect(auth.CCR_OAUTH_TOKEN_PATH).toBeNull();
    expect(auth.getOAuthTokenFromFileDescriptor()).toBeNull();
    auth.maybePersistTokenForSubprocesses(auth.CCR_OAUTH_TOKEN_PATH, "secret", "OAuth token");
    await expect(stat(join(cwd, ".agenc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards remote token dir overrides to spawned teammates", async () => {
    process.env.AGENC_REMOTE_TOKEN_DIR = "/remote/tokens";

    const { buildInheritedEnvVars } = await loadSpawnUtils();

    expect(buildInheritedEnvVars()).toContain("AGENC_REMOTE_TOKEN_DIR=/remote/tokens");
  });
});

async function loadAuthFileDescriptor(): Promise<typeof import("../utils/authFileDescriptor.js")> {
  vi.resetModules();
  return import("../utils/authFileDescriptor.js");
}

async function loadSpawnUtils(): Promise<typeof import("../utils/swarm/spawnUtils.js")> {
  vi.resetModules();
  vi.doMock("../bootstrap/state.js", () => ({
    getChromeFlagOverride: () => undefined,
    getFlagSettingsPath: () => undefined,
    getInlinePlugins: () => [],
    getMainLoopModelOverride: () => undefined,
    getSessionBypassPermissionsMode: () => false,
  }));
  vi.doMock("../agenc/upstream/utils/bundledMode.js", () => ({ isInBundledMode: () => false }));
  vi.doMock("../agenc/upstream/utils/swarm/backends/teammateModeSnapshot.js", () => ({
    getTeammateModeFromSnapshot: () => "default",
  }));
  return import("../utils/swarm/spawnUtils.js");
}

async function tempHomeWithToken(token: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agenc-remote-token-home-"));
  await writeToken(join(home, ".agenc", "remote"), token);
  return home;
}

async function tempTokenDirWithToken(token: string): Promise<string> {
  const tokenDir = await mkdtemp(join(tmpdir(), "agenc-remote-token-dir-"));
  await writeToken(tokenDir, token);
  return tokenDir;
}

async function writeToken(tokenDir: string, token: string): Promise<void> {
  await mkdir(tokenDir, { recursive: true });
  await writeFile(join(tokenDir, ".oauth_token"), `${token}\n`);
}

function resetEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV, { NODE_ENV: "test" });
  delete process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR;
}
