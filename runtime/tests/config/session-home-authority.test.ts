import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import {
  clearCurrentRuntimeSession,
  getCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";
import {
  resolveAgentRuntimeOptions,
  resolveSessionTempRoot,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import { getAgenCHomeDir } from "../../src/utils/envUtils.js";
import { resolveSecureStorageHome } from "../../src/utils/secureStorage/home.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { getAttributionTexts } from "../../src/utils/attribution.js";

function sessionAt(
  homePath: string,
  sessionTempRoot?: string,
  remote?: {
    readonly mode: boolean;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
): Session {
  const homeContext = resolveHomeContext({ AGENC_HOME: homePath });
  return {
    services: {
      runtimeOptions: resolveAgentRuntimeOptions(
        {},
        {
          ...(sessionTempRoot === undefined ? {} : { sessionTempRoot }),
          ...(remote === undefined ? {} : { remoteMode: remote.mode }),
        },
      ),
      ...(remote === undefined
        ? {}
        : {
            providerService: {
              current: () => ({ provider: "grok", model: "grok-test" }),
              environment: () => remote.environment,
            },
          }),
      configStore: {
        homeContext,
        agencHome: homeContext.path,
      },
    },
  } as unknown as Session;
}

function authorityAt(homePath: string) {
  const homeContext = resolveHomeContext({ AGENC_HOME: homePath });
  return {
    current: () => ({}),
    sources: () => [],
    projectRoot: "/tmp",
    homeContext,
    stateRepository: { getNamespace: () => ({}) },
    reload: async () => {},
    subscribe: () => {},
  } as never;
}

afterEach(() => clearCurrentRuntimeSession());

describe("session-bound home authority", () => {
  test("isolates canonical and secure-storage homes across concurrent sessions", async () => {
    const sessionA = sessionAt(join("/tmp", "agenc-session-home-a"));
    const sessionB = sessionAt(join("/tmp", "agenc-session-home-b"));

    const [a, b] = await Promise.all([
      runWithCurrentRuntimeSession(sessionA, async () => {
        await Promise.resolve();
        return [
          getAgenCHomeDir(),
          resolveSecureStorageHome().path,
          resolveSecureStorageHome({
            AGENC_HOME: join("/tmp", "conflicting-captured-home-a"),
          }).path,
          resolveSecureStorageHome({}).path,
        ] as const;
      }),
      runWithCurrentRuntimeSession(sessionB, async () => {
        await Promise.resolve();
        return [
          getAgenCHomeDir(),
          resolveSecureStorageHome().path,
          resolveSecureStorageHome({
            AGENC_HOME: join("/tmp", "conflicting-captured-home-b"),
          }).path,
          resolveSecureStorageHome({}).path,
        ] as const;
      }),
    ]);

    expect(a).toEqual([
      join("/tmp", "agenc-session-home-a"),
      join("/tmp", "agenc-session-home-a"),
      join("/tmp", "agenc-session-home-a"),
      join("/tmp", "agenc-session-home-a"),
    ]);
    expect(b).toEqual([
      join("/tmp", "agenc-session-home-b"),
      join("/tmp", "agenc-session-home-b"),
      join("/tmp", "agenc-session-home-b"),
      join("/tmp", "agenc-session-home-b"),
    ]);
  });

  test("isolates temp roots across concurrent daemon sessions", async () => {
    const sessionA = sessionAt(
      join("/tmp", "agenc-session-home-a"),
      join("/tmp", "agenc-session-temp-a"),
    );
    const sessionB = sessionAt(
      join("/tmp", "agenc-session-home-b"),
      join("/tmp", "agenc-session-temp-b"),
    );

    const [rootA, rootB] = await Promise.all([
      runWithCurrentRuntimeSession(sessionA, async () => {
        await Promise.resolve();
        return resolveSessionTempRoot();
      }),
      runWithCurrentRuntimeSession(sessionB, async () => {
        await Promise.resolve();
        return resolveSessionTempRoot();
      }),
    ]);

    expect(rootA).toBe(join("/tmp", "agenc-session-temp-a"));
    expect(rootB).toBe(join("/tmp", "agenc-session-temp-b"));
  });

  test("uses an explicit startup scope before an ambiguous session fallback", async () => {
    setCurrentRuntimeSession(sessionAt(join("/tmp", "agenc-fallback-a")));
    setCurrentRuntimeSession(sessionAt(join("/tmp", "agenc-fallback-b")));
    const scopedRoot = join("/tmp", "agenc-scoped-startup-temp");
    const options = resolveAgentRuntimeOptions(
      {},
      { sessionTempRoot: scopedRoot },
    );

    await expect(
      runWithAgentRuntimeOptions(options, async () => {
        await Promise.resolve();
        return resolveSessionTempRoot();
      }),
    ).resolves.toBe(scopedRoot);
  });

  test("keeps a turn-bound session ahead of an outer startup scope", () => {
    const startupRoot = join("/tmp", "agenc-outer-startup-temp");
    const sessionRoot = join("/tmp", "agenc-inner-session-temp");
    const session = sessionAt(join("/tmp", "agenc-session-home"), sessionRoot);
    const options = resolveAgentRuntimeOptions(
      {},
      { sessionTempRoot: startupRoot },
    );

    expect(
      runWithAgentRuntimeOptions(options, () =>
        runWithCurrentRuntimeSession(session, resolveSessionTempRoot),
      ),
    ).toBe(sessionRoot);
  });

  test("isolates remote attribution metadata across concurrent daemon sessions", async () => {
    const sessionA = sessionAt(
      join("/tmp", "agenc-session-home-a"),
      undefined,
      {
        mode: true,
        environment: {
          AGENC_REMOTE_SESSION_ID: "session-client-a",
          SESSION_INGRESS_URL: "https://ingress-a.example",
        },
      },
    );
    const sessionB = sessionAt(
      join("/tmp", "agenc-session-home-b"),
      undefined,
      {
        mode: true,
        environment: {
          AGENC_REMOTE_SESSION_ID: "session-client-b",
          SESSION_INGRESS_URL: "https://ingress-b.example",
        },
      },
    );

    const [attributionA, attributionB] = await Promise.all([
      runWithCurrentRuntimeSession(sessionA, async () => {
        await Promise.resolve();
        return getAttributionTexts();
      }),
      runWithCurrentRuntimeSession(sessionB, async () => {
        await Promise.resolve();
        return getAttributionTexts();
      }),
    ]);

    expect(attributionA).toEqual({
      commit: "https://agenc.tech/code/session-client-a",
      pr: "https://agenc.tech/code/session-client-a",
    });
    expect(attributionB).toEqual({
      commit: "https://agenc.tech/code/session-client-b",
      pr: "https://agenc.tech/code/session-client-b",
    });
  });

  test("uses startup ConfigStore authority before ambient or captured env", () => {
    const startupHome = join("/tmp", "agenc-startup-authority-home");
    const result = runWithCanonicalSettingsAuthority(
      authorityAt(startupHome),
      () => [
        getAgenCHomeDir(),
        resolveSecureStorageHome({
          AGENC_HOME: join("/tmp", "conflicting-startup-home"),
        }).path,
      ],
    );

    expect(result).toEqual([startupHome, startupHome]);
  });

  test("refuses the ambiguous session fallback while retaining startup home authority", () => {
    setCurrentRuntimeSession(sessionAt(join("/tmp", "agenc-fallback-a")));
    setCurrentRuntimeSession(sessionAt(join("/tmp", "agenc-fallback-b")));

    expect(() => getCurrentRuntimeSession()).toThrow(/Ambiguous runtime session/u);
    expect(getAgenCHomeDir()).toBe(process.env.AGENC_HOME);
    expect(resolveSecureStorageHome().path).toBe(process.env.AGENC_HOME);
  });

  test("rejects an active session without ConfigStore authority", () => {
    const session = { services: {} } as unknown as Session;
    expect(() => runWithCurrentRuntimeSession(session, getAgenCHomeDir))
      .toThrow(/no canonical ConfigStore home authority/u);
  });

  test("keeps explicit pre-session secure-storage home inputs explicit", () => {
    const explicit = join("/tmp", "agenc-explicit-secure-home");
    expect(resolveSecureStorageHome({}, explicit).path).toBe(explicit);
  });
});
