/**
 * Ports upstream runtime `core/tests/suite/personality_migration.rs`
 * scenarios onto AgenC's one-shot personality migration entrypoint.
 *
 * Shape difference from upstream:
 *   - Legacy `config.json` is migrated into AgenC's current `config.toml`
 *     before the personality edit is applied.
 */

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

import { parseToml } from "../config/loader.js";
import { defaultConfig, mergeConfigs, type AgenCConfig } from "../config/schema.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import {
  maybeMigratePersonality,
  PERSONALITY_MIGRATION_FILENAME,
} from "./migration.js";

const TEST_PROVIDER = "grok";
const TEST_MODEL = "grok-4-fast";
const LEGACY_CONFIG_MODEL = "gpt-5.3-codex"; // branding-scan: allow OpenAI model identifier
const MARKER_CONTENTS = "v1\n";

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

async function runMigration(params: {
  readonly home: string;
  readonly cwd: string;
  readonly config?: AgenCConfig;
}) {
  return await maybeMigratePersonality({
    agencHome: params.home,
    cwd: params.cwd,
    config: params.config ?? defaultConfig(),
    defaultModelProviderId: TEST_PROVIDER,
  });
}

function withAgencHome<T>(home: string, fn: () => T): T {
  const previous = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENC_HOME;
    } else {
      process.env.AGENC_HOME = previous;
    }
  }
}

function writeRecordedThread(params: {
  readonly home: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly archived?: boolean;
}): void {
  withAgencHome(params.home, () => {
    const rolloutStore = new RolloutStore({
      cwd: params.cwd,
      sessionId: params.threadId,
      agencVersion: "0.2.0",
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: params.threadId,
      timestamp: new Date().toISOString(),
      cwd: params.cwd,
      originator: "personality-migration-contract-test",
      agencVersion: "0.2.0",
      model: TEST_MODEL,
      modelProvider: TEST_PROVIDER,
    });
    const threadStore = new FileThreadStore({
      cwd: params.cwd,
      agencHome: params.home,
      defaultModelProviderId: TEST_PROVIDER,
    });
    try {
      threadStore.createThread({
        threadId: params.threadId,
        rolloutStore,
        cwd: params.cwd,
        model: TEST_MODEL,
        modelProvider: TEST_PROVIDER,
      });
      threadStore.appendItems({
        threadId: params.threadId,
        items: [
          {
            type: "response_item",
            payload: { role: "user", content: "hello" },
          },
        ],
      });
      if (params.archived === true) {
        threadStore.archiveThread({ threadId: params.threadId });
      }
      threadStore.shutdownThread(params.threadId);
    } finally {
      threadStore.close();
      rolloutStore.close();
    }
  });
}

async function readConfigToml(home: string): Promise<Record<string, unknown>> {
  return parseToml(await readFile(join(home, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function expectMarker(home: string): Promise<void> {
  await expect(
    readFile(join(home, PERSONALITY_MIGRATION_FILENAME), "utf8"),
  ).resolves.toBe(MARKER_CONTENTS);
}

describe("personality migration contract", () => {
  test("applies_when_sessions_exist_and_no_personality", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");
    writeRecordedThread({ home, cwd, threadId: "active-thread" });

    await expect(runMigration({ home, cwd })).resolves.toBe("Applied");

    await expectMarker(home);
    await expect(readConfigToml(home)).resolves.toMatchObject({
      configVersion: 1,
      personality: "pragmatic",
    });
  });

  test("applies_when_only_archived_sessions_exist_and_no_personality", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");
    writeRecordedThread({
      home,
      cwd,
      threadId: "archived-thread",
      archived: true,
    });

    await expect(runMigration({ home, cwd })).resolves.toBe("Applied");

    await expectMarker(home);
    await expect(readConfigToml(home)).resolves.toMatchObject({
      personality: "pragmatic",
    });
  });

  test("skips_when_marker_exists", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");
    writeFileSync(
      join(home, PERSONALITY_MIGRATION_FILENAME),
      MARKER_CONTENTS,
    );
    writeRecordedThread({ home, cwd, threadId: "marker-thread" });

    await expect(runMigration({ home, cwd })).resolves.toBe("SkippedMarker");

    await expectMarker(home);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("skips_when_personality_explicit", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");
    writeRecordedThread({ home, cwd, threadId: "explicit-thread" });
    writeFileSync(join(home, "config.toml"), 'personality = "friendly"\n');
    const config = mergeConfigs(defaultConfig(), { personality: "friendly" });

    await expect(runMigration({ home, cwd, config })).resolves.toBe(
      "SkippedExplicitPersonality",
    );

    await expectMarker(home);
    await expect(readConfigToml(home)).resolves.toMatchObject({
      personality: "friendly",
    });
  });

  test("skips_when_no_sessions", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");

    await expect(runMigration({ home, cwd })).resolves.toBe("SkippedNoSessions");

    await expectMarker(home);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("applies_when_legacy_config_json_exists_and_no_personality", async () => {
    const home = tempDir("agenc-personality-contract-home-");
    const cwd = tempDir("agenc-personality-contract-cwd-");
    writeRecordedThread({ home, cwd, threadId: "json-thread" });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ model: LEGACY_CONFIG_MODEL }),
    );

    await expect(runMigration({ home, cwd })).resolves.toBe("Applied");

    await expectMarker(home);
    await expect(readConfigToml(home)).resolves.toMatchObject({
      configVersion: 1,
      model: LEGACY_CONFIG_MODEL,
      personality: "pragmatic",
    });
    expect(existsSync(join(home, "config.json.bak-cf12"))).toBe(true);
  });
});
