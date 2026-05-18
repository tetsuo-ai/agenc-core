import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { defaultConfig, mergeConfigs } from "../config/schema.js";
import { parseToml } from "../config/loader.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import {
  maybeMigratePersonality,
  PERSONALITY_MIGRATION_FILENAME,
} from "./migration.js";

const TEST_PROVIDER = "grok";

let previousAgencHome: string | undefined;
let tempRoots: string[] = [];

beforeEach(() => {
  previousAgencHome = process.env.AGENC_HOME;
});

afterEach(() => {
  if (previousAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = previousAgencHome;
  }
  previousAgencHome = undefined;
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function setAgencHome(home: string): void {
  process.env.AGENC_HOME = home;
}

async function runMigration(params: {
  readonly home: string;
  readonly cwd: string;
  readonly config?: ReturnType<typeof defaultConfig>;
  readonly activeProfileName?: string;
  readonly defaultModelProviderId?: string;
}) {
  return await maybeMigratePersonality({
    agencHome: params.home,
    cwd: params.cwd,
    config: params.config ?? defaultConfig(),
    defaultModelProviderId: params.defaultModelProviderId ?? TEST_PROVIDER,
    ...(params.activeProfileName !== undefined
      ? { activeProfileName: params.activeProfileName }
      : {}),
  });
}

function writeRecordedThread(params: {
  readonly home: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly provider?: string;
  readonly archived?: boolean;
}): void {
  setAgencHome(params.home);
  const rollout = new RolloutStore({
    cwd: params.cwd,
    sessionId: params.threadId,
    agencVersion: "0.2.0",
    autoStartScheduler: false,
  });
  rollout.open({
    sessionId: params.threadId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
    originator: "personality-migration-test",
    agencVersion: "0.2.0",
    model: "grok-4-fast",
    ...(params.provider !== undefined ? { modelProvider: params.provider } : {}),
  });
  const store = new FileThreadStore({
    cwd: params.cwd,
    agencHome: params.home,
    defaultModelProviderId: TEST_PROVIDER,
  });
  try {
    store.createThread({
      threadId: params.threadId,
      rolloutStore: rollout,
      cwd: params.cwd,
      model: "grok-4-fast",
      ...(params.provider !== undefined ? { modelProvider: params.provider } : {}),
    });
    store.appendItems({
      threadId: params.threadId,
      items: [
        {
          type: "response_item",
          payload: { role: "user", content: "hello" },
        },
      ],
    });
    if (params.archived === true) {
      store.archiveThread({ threadId: params.threadId });
    }
    store.shutdownThread(params.threadId);
  } finally {
    store.close();
    rollout.close();
  }
}

async function readConfig(home: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(home, "config.toml"), "utf8");
  return parseToml(text) as Record<string, unknown>;
}

describe("personality migration", () => {
  test("skips when the marker exists without writing config", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    writeFileSync(join(home, PERSONALITY_MIGRATION_FILENAME), "v1\n");

    await expect(runMigration({ home, cwd })).resolves.toBe("SkippedMarker");

    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("skips and writes marker when top-level personality is explicit", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    writeFileSync(join(home, "config.toml"), 'personality = "friendly"\n');
    const config = mergeConfigs(defaultConfig(), { personality: "friendly" });

    await expect(runMigration({ home, cwd, config })).resolves.toBe(
      "SkippedExplicitPersonality",
    );

    expect(existsSync(join(home, PERSONALITY_MIGRATION_FILENAME))).toBe(true);
    await expect(readConfig(home)).resolves.toMatchObject({
      personality: "friendly",
    });
  });

  test("skips when the active profile pins personality", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    const config = mergeConfigs(defaultConfig(), {
      profiles: {
        team: {
          personality: "friendly",
        },
      },
    });
    writeRecordedThread({ home, cwd, threadId: "profile-thread", provider: TEST_PROVIDER });

    await expect(
      runMigration({ home, cwd, config, activeProfileName: "team" }),
    ).resolves.toBe("SkippedExplicitPersonality");

    expect(existsSync(join(home, PERSONALITY_MIGRATION_FILENAME))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("skips and writes marker when no sessions are recorded", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");

    await expect(runMigration({ home, cwd })).resolves.toBe("SkippedNoSessions");

    expect(existsSync(join(home, PERSONALITY_MIGRATION_FILENAME))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("applies pragmatic personality when an active session exists", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    writeRecordedThread({ home, cwd, threadId: "active-thread", provider: TEST_PROVIDER });

    await expect(runMigration({ home, cwd })).resolves.toBe("Applied");

    expect(existsSync(join(home, PERSONALITY_MIGRATION_FILENAME))).toBe(true);
    await expect(readConfig(home)).resolves.toMatchObject({
      configVersion: 1,
      personality: "pragmatic",
    });
  });

  test("applies when only archived sessions exist", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    writeRecordedThread({
      home,
      cwd,
      threadId: "archived-thread",
      provider: TEST_PROVIDER,
      archived: true,
    });

    await expect(runMigration({ home, cwd })).resolves.toBe("Applied");

    await expect(readConfig(home)).resolves.toMatchObject({
      personality: "pragmatic",
    });
  });

  test("ignores sessions recorded under a different default provider", async () => {
    const home = tempDir("agenc-personality-home-");
    const cwd = tempDir("agenc-personality-cwd-");
    writeRecordedThread({ home, cwd, threadId: "other-provider", provider: "openai" });

    await expect(runMigration({ home, cwd })).resolves.toBe("SkippedNoSessions");

    expect(existsSync(join(home, PERSONALITY_MIGRATION_FILENAME))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });
});
