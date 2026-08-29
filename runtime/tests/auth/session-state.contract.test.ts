import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
  remoteAuthSessionTokenSync,
} from "./session-state.js";
import { getSecureStorage } from "../utils/secureStorage/index.js";
import {
  captureSecureStorageIngress,
  resolveSecureStorageHome,
} from "../utils/secureStorage/home.js";

const CREATED_AT = "2026-08-24T00:00:00.000Z";

describe("remote auth session state", () => {
  const homes: string[] = [];

  beforeEach(() => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
  });

  afterEach(async () => {
    getSecureStorage(resolveSecureStorageHome(process.env)).delete();
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("joins secret-free metadata with the native bearer", async () => {
    const home = await createRemoteMetadataHome(homes, {
      subscriptionTier: "team",
    });
    getSecureStorage(resolveSecureStorageHome({}, home)).update({
      remoteAuth: {
        bearerToken: "native-bearer",
        createdAt: CREATED_AT,
      },
    });
    const env = { AGENC_HOME: home };

    const context = captureSecureStorageIngress(env);
    expect(remoteAuthSessionTokenSync(context)).toBe("native-bearer");
    expect(remoteAuthSessionSubscriptionTierSync(context)).toBe("team");
    expect(hasRemoteAuthSessionSync(context)).toBe(true);
    expect(hasEntitledRemoteAuthSessionSync(context)).toBe(true);
    expect(await readFile(join(home, "auth.json"), "utf8")).not.toContain(
      "native-bearer",
    );
  });

  it("joins metadata and bearer from the captured local-OAuth namespace", async () => {
    const home = await createRemoteMetadataHome(homes, {
      subscriptionTier: "team",
    });
    const env = {
      AGENC_HOME: home,
      HOME: tmpdir(),
      USER_TYPE: "ant",
      USE_LOCAL_OAUTH: "1",
    };
    getSecureStorage(resolveSecureStorageHome(env, home)).update({
      remoteAuth: {
        bearerToken: "local-oauth-native-bearer",
        createdAt: CREATED_AT,
      },
    });

    const context = captureSecureStorageIngress(env);
    expect(remoteAuthSessionTokenSync(context)).toBe(
      "local-oauth-native-bearer",
    );
    expect(hasEntitledRemoteAuthSessionSync(context)).toBe(true);
  });

  it("does not treat a legacy plaintext auth.json token as authority", async () => {
    const home = await createRemoteMetadataHome(homes, {
      token: "legacy-plaintext-bearer",
      subscriptionTier: "team",
    });
    const env = { AGENC_HOME: home };

    const context = captureSecureStorageIngress(env);
    expect(remoteAuthSessionTokenSync(context)).toBeUndefined();
    expect(remoteAuthSessionSubscriptionTierSync(context)).toBeUndefined();
    expect(hasRemoteAuthSessionSync(context)).toBe(false);
  });

  it("lets an explicit env bearer beat persisted native auth", async () => {
    const home = await createRemoteMetadataHome(homes, {
      subscriptionTier: "team",
    });
    getSecureStorage(resolveSecureStorageHome({}, home)).update({
      remoteAuth: {
        bearerToken: "persisted-bearer",
        createdAt: CREATED_AT,
      },
    });
    const env = {
      AGENC_HOME: home,
      AGENC_REMOTE_AUTH_TOKEN: " explicit-bearer ",
    };

    const context = captureSecureStorageIngress(env);
    expect(remoteAuthSessionTokenSync(context)).toBe("explicit-bearer");
    expect(hasRemoteAuthSessionSync(context)).toBe(true);
    // Metadata belongs to the persisted login, not to an ephemeral override.
    expect(remoteAuthSessionSubscriptionTierSync(context)).toBeUndefined();
  });

  it("rejects expired persisted sessions", async () => {
    const home = await createRemoteMetadataHome(homes, {
      expiresAt: "2000-01-01T00:00:00.000Z",
      subscriptionTier: "team",
    });
    getSecureStorage(resolveSecureStorageHome({}, home)).update({
      remoteAuth: {
        bearerToken: "expired-bearer",
        createdAt: CREATED_AT,
      },
    });

    expect(
      hasRemoteAuthSessionSync(
        captureSecureStorageIngress({ AGENC_HOME: home }),
      ),
    ).toBe(false);
  });
});

async function createRemoteMetadataHome(
  homes: string[],
  extra: Readonly<Record<string, unknown>>,
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agenc-auth-session-state-"));
  homes.push(home);
  await writeFile(
    join(home, "auth.json"),
    `${JSON.stringify({
      version: 1,
      provider: "remote",
      createdAt: CREATED_AT,
      ...extra,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return home;
}
