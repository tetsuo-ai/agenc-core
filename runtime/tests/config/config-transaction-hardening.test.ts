import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { firstPlaintextCredentialPath } from "../../src/config/credential-classification.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  rollbackConfigV2Migration,
} from "../../src/config/migration.js";
import {
  ConfigRepositoryError,
  loadLayeredConfig,
  validateStrictConfigDocument,
} from "../../src/config/repository.js";

const temporaryDirectories: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "agenc-config-transaction-hardening-"));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function migrationOptions(root: string, id: string) {
  return {
    env: {},
    home: join(root, "home"),
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "managed", "config.toml"),
    managedSettingsPath: join(
      root,
      "managed",
      `${["managed", "settings"].join("-")}.json`,
    ),
    globalStatePath: join(root, "missing-global-state.json"),
    id,
  } as const;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("configuration transaction path hardening", () => {
  test.skipIf(process.platform === "win32")(
    "rejects a symbolic-link ancestor above managed policy",
    async () => {
      const root = temp();
      const authority = join(root, "managed-authority");
      const alias = join(root, "managed-alias");
      const configPath = join(authority, "config.toml");
      write(configPath, "config_version = 2\ndisableAllHooks = true\n");
      symlinkSync(authority, alias, "dir");

      await expect(loadLayeredConfig({
        env: { AGENC_HOME: join(root, "home") },
        managedConfigPath: join(alias, "config.toml"),
        managedDropInDir: join(alias, "config.d"),
      })).rejects.toMatchObject({
        code: "invalid-source",
        message: expect.stringMatching(/symbolic-link ancestor/u),
      } satisfies Partial<ConfigRepositoryError>);
      expect(readFileSync(configPath, "utf8")).toContain("disableAllHooks");
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a symbolic-link migration journal ancestor without writing outside home",
    async () => {
      const root = temp();
      const options = migrationOptions(root, "journal-ancestor-symlink");
      const target = join(options.home, "config.toml");
      const original = 'configVersion = 1\nmodel = "before"\n';
      write(target, original);
      const plan = await checkConfigV2Migration(options);
      expect(plan.conflicts).toEqual([]);

      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(options.home, "migrations"), "dir");

      await expect(applyConfigV2Migration(plan)).rejects.toThrow(/symbolic link/u);
      expect(existsSync(join(outside, "config-v2"))).toBe(false);
      expect(readFileSync(target, "utf8")).toBe(original);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a symbolic-link transaction directory during rollback",
    async () => {
      const root = temp();
      const home = join(root, "home");
      const id = "rollback-directory-symlink";
      const outside = join(root, "outside-transaction");
      write(join(outside, "journal.json"), `${JSON.stringify({
        journal_version: 1,
        id,
        created_at: new Date(0).toISOString(),
        status: "rolled-back",
        writes: [],
        archives: [],
        committed: {
          credential: false,
          credentialFileIndexes: [],
          writeIndexes: [],
          archiveIndexes: [],
        },
      }, null, 2)}\n`);
      const transactionRoot = join(home, "migrations", "config-v2");
      mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
      symlinkSync(outside, join(transactionRoot, id), "dir");

      await expect(rollbackConfigV2Migration(id, {
        env: {},
        home,
      })).rejects.toThrow(/symbolic link/u);
      expect(readFileSync(join(outside, "journal.json"), "utf8")).toContain(
        '"status": "rolled-back"',
      );
    },
  );

  test("recovers a validated preparation manifest left before journal publication", async () => {
    const root = temp();
    const options = migrationOptions(root, "fresh-after-interruption");
    const target = join(options.home, "config.toml");
    write(target, 'configVersion = 1\nmodel = "before"\n');
    const plan = await checkConfigV2Migration(options);
    expect(plan.conflicts).toEqual([]);

    const interruptedId = "interrupted-preparation";
    const interruptedDir = join(
      options.home,
      "migrations",
      "config-v2",
      interruptedId,
    );
    const ownerPath = join(root, "orphan-target.toml");
    const stagePath = `${ownerPath}.migrate-v2-${interruptedId}.tmp`;
    const stageContent = "validated interrupted stage\n";
    const publicationTempPath = join(
      interruptedDir,
      "preparation.json.tmp-123-12345678-1234-4123-8123-123456789abc",
    );
    write(stagePath, stageContent);
    write(publicationTempPath, "interrupted publication stage\n");
    write(join(interruptedDir, "preparation.json"), `${JSON.stringify({
      preparation_version: 1,
      id: interruptedId,
      created_at: new Date(0).toISOString(),
      artifacts: [{
        kind: "write-stage",
        path: stagePath,
        ownerPath,
        sha256: hash(stageContent),
      }],
    }, null, 2)}\n`);

    await expect(applyConfigV2Migration(plan)).resolves.toMatchObject({
      id: options.id,
    });
    expect(existsSync(stagePath)).toBe(false);
    expect(existsSync(publicationTempPath)).toBe(false);
    expect(existsSync(join(interruptedDir, "preparation.json"))).toBe(false);
  });

  test("cleans preparation artifacts after an interrupted journal is rolled back", async () => {
    const root = temp();
    const options = migrationOptions(root, "fresh-after-rolled-back");
    const target = join(options.home, "config.toml");
    write(target, 'configVersion = 1\nmodel = "before"\n');
    const plan = await checkConfigV2Migration(options);
    expect(plan.conflicts).toEqual([]);

    const interruptedId = "rolled-back-interruption";
    const interruptedDir = join(
      options.home,
      "migrations",
      "config-v2",
      interruptedId,
    );
    const ownerPath = join(root, "rolled-back-orphan.toml");
    const stagePath = `${ownerPath}.migrate-v2-${interruptedId}.tmp`;
    const stageContent = "rolled-back interrupted stage\n";
    write(stagePath, stageContent);
    write(join(interruptedDir, "preparation.json"), `${JSON.stringify({
      preparation_version: 1,
      id: interruptedId,
      created_at: new Date(0).toISOString(),
      artifacts: [{
        kind: "write-stage",
        path: stagePath,
        ownerPath,
        sha256: hash(stageContent),
      }],
    }, null, 2)}\n`);
    write(join(interruptedDir, "journal.json"), `${JSON.stringify({
      journal_version: 1,
      id: interruptedId,
      created_at: new Date(0).toISOString(),
      status: "rolled-back",
      writes: [],
      archives: [],
      committed: {
        credential: false,
        credentialFileIndexes: [],
        writeIndexes: [],
        archiveIndexes: [],
      },
    }, null, 2)}\n`);

    await expect(applyConfigV2Migration(plan)).resolves.toMatchObject({
      id: options.id,
    });
    expect(existsSync(stagePath)).toBe(false);
    expect(existsSync(join(interruptedDir, "preparation.json"))).toBe(false);
    expect(existsSync(join(interruptedDir, "journal.json"))).toBe(true);
  });
});

describe("plaintext credential persistence boundaries", () => {
  test("detects nested and plural credential families without returning values", () => {
    expect(firstPlaintextCredentialPath({
      auth: { accessTokens: ["first-secret-value"] },
    })).toBe("auth.accessTokens[0]");
    expect(firstPlaintextCredentialPath({
      credentials: [{ label: "only-secret-value" }],
    })).toBe("credentials[0].label");
  });

  test("rejects credential-like shell environment names but keeps non-secret values", () => {
    expect(() => validateStrictConfigDocument({
      config_version: 2,
      shell_environment_policy: {
        set: { XAI_API_KEY: "literal-secret-must-not-leak" },
      },
    })).toThrow(/shell_environment_policy\.set\.XAI_API_KEY/u);

    expect(validateStrictConfigDocument({
      config_version: 2,
      shell_environment_policy: { set: { LANG: "en_CA.UTF-8" } },
    }).shell_environment_policy).toEqual({
      set: { LANG: "en_CA.UTF-8" },
    });
  });

  test("blocks plaintext credentials in retired settings without copying values into a plan", async () => {
    const root = temp();
    const options = migrationOptions(root, "retired-settings-secret");
    const secret = "settings-secret-must-not-leak";
    write(
      join(options.home, "settings.json"),
      `${JSON.stringify({ env: { XAI_API_KEY: secret } })}\n`,
    );

    const plan = await checkConfigV2Migration(options);
    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "env.XAI_API_KEY",
        reason: expect.stringMatching(/plaintext credential/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(secret);
  });

  test("blocks a literal MCP authorization header while allowing environment references", async () => {
    const root = temp();
    const options = migrationOptions(root, "retired-mcp-secret");
    const secret = "mcp-secret-must-not-leak";
    write(join(options.projectRoot, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.example.test/api",
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    })}\n`);

    const blocked = await checkConfigV2Migration(options);
    expect(blocked.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "mcpServers.docs.headers.Authorization",
        reason: expect.stringMatching(/plaintext credential/u),
      }),
    ]));
    expect(blocked.writes).toEqual([]);
    expect(JSON.stringify(blocked)).not.toContain(secret);

    write(join(options.projectRoot, ".mcp.json"), `${JSON.stringify({
      mcpServers: {
        docs: {
          type: "http",
          url: "https://mcp.example.test/api",
          headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        },
      },
    })}\n`);
    const allowed = await checkConfigV2Migration({
      ...options,
      id: "retired-mcp-environment-reference",
    });
    expect(allowed.conflicts).toEqual([]);
  });
});
