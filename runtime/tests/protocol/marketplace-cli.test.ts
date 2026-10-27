/**
 * A2 — MarketplaceKitCliAdapter tests against a fake `agenc-marketplace`
 * binary (see `./fixture.ts`). Verifies:
 *
 *   - read-only list/detail invocations use the exact argv contract
 *     (`--json`, mainnet, no shell) and parse canned JSON defensively;
 *   - untrusted text is sanitized (no ANSI escapes / control chars);
 *   - PDA-shaped argument validation runs BEFORE any spawn (shell
 *     metacharacters, quotes, flag smuggling all rejected with zero
 *     child processes);
 *   - a missing binary is a clean typed CLI_NOT_FOUND error (no npx);
 *   - `success: false` and non-JSON output map to typed errors;
 *   - every mutating verb returns VERB_NOT_ENABLED (owner-gated).
 */

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLI_ENV_ALLOWLIST,
  MarketplaceKitCliAdapter,
  minimalCliEnv,
  resolveInstalledKitBinary,
} from "../../src/protocol/marketplace-cli.js";
import { createProtocolTransport } from "../../src/protocol/index.js";
import { isValidTaskPda, sanitizeUntrustedText } from "../../src/protocol/types.js";
import {
  FIXTURE_TASK_PDA_1,
  FIXTURE_TASK_PDA_2,
  writeCliFixture,
} from "./fixture.js";

/** Env for spawning the shebang fixture: PATH only, no ambient AGENC_*. */
const CLEAN_SPAWN_ENV: Readonly<Record<string, string | undefined>> = {
  PATH: process.env.PATH,
};

function adapterFor(binPath: string): MarketplaceKitCliAdapter {
  return new MarketplaceKitCliAdapter({
    cliPath: binPath,
    env: CLEAN_SPAWN_ENV,
    timeoutMs: 15_000,
  });
}

describe("MarketplaceKitCliAdapter — read-only verbs", () => {
  it("listClaimable shells out with the exact readonly argv and parses tasks", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    const result = await adapter.listClaimable({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exact argv contract — no shell, no extra verbs, mainnet + --json.
    expect(fixture.invocations()).toEqual([
      [
        "--network",
        "mainnet",
        "--json",
        "tasks",
        "list-claimable",
        "--limit",
        "10",
        "--compact",
      ],
    ]);

    // Shape-invalid canned entries are dropped, valid ones parsed.
    expect(result.value.tasks.map((t) => t.taskPda)).toEqual([
      FIXTURE_TASK_PDA_1,
      FIXTURE_TASK_PDA_2,
    ]);
    expect(result.value.tasks[0]?.status).toBe("open");
    expect(result.value.tasks[0]?.reward).toBe("0.5 SOL");
  });

  it("clamps the list limit into 1..50 and defaults to 10", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    await adapter.listClaimable({ limit: 9_999 });
    await adapter.listClaimable({ limit: -3 });
    await adapter.listClaimable();

    const limits = fixture
      .invocations()
      .map((argv) => argv[argv.indexOf("--limit") + 1]);
    expect(limits).toEqual(["50", "1", "10"]);
  });

  it("sanitizes untrusted task text: no ANSI escapes or control chars survive", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    const result = await adapter.listClaimable();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const description = result.value.tasks[0]?.description ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toContain("\u001b");
    expect(description).not.toContain("\n");
    expect(description).toContain("thing");
  });

  it("taskDetail validates then fetches, echoing the requested PDA", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    const result = await adapter.taskDetail(FIXTURE_TASK_PDA_1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fixture.invocations()).toEqual([
      ["--network", "mainnet", "--json", "explorer", "task", FIXTURE_TASK_PDA_1],
    ]);
    expect(result.value.taskPda).toBe(FIXTURE_TASK_PDA_1);
    expect(result.value.status).toBe("open");
    expect(result.value.reward).toBe("0.5 SOL");
    expect(result.value.moderation).toEqual({
      status: "clear",
      riskScore: 3,
      advisoryOnly: true,
      hardBoundary: false,
    });
    expect(result.value.description).not.toContain("\u001b");
  });
});

describe("MarketplaceKitCliAdapter — pre-spawn argument validation", () => {
  const HOSTILE_PDAS = [
    "abc; rm -rf /",
    "$(reboot)",
    "`touch /tmp/pwn`",
    "--yes",
    "-y",
    "So1111'1111111111111111111111111111111112",
    'So1111"1111111111111111111111111111111112',
    "So11111111111111111111111111111111111111112 extra",
    "So11111111\n111111111111111111111111111112",
    "short",
    "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", // non-base58 alphabet
    "1".repeat(45), // over-length
    "",
  ];

  it("rejects malformed / hostile PDAs with INVALID_ARGUMENT and never spawns", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    for (const hostile of HOSTILE_PDAS) {
      expect(isValidTaskPda(hostile)).toBe(false);
      const result = await adapter.taskDetail(hostile);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("INVALID_ARGUMENT");
      expect(result.error.message).toContain("No command was executed");
    }
    // Zero child processes for the whole hostile batch.
    expect(fixture.invocations()).toEqual([]);
  });

  it("accepts well-formed base58 PDAs", () => {
    expect(isValidTaskPda(FIXTURE_TASK_PDA_1)).toBe(true);
    expect(isValidTaskPda(FIXTURE_TASK_PDA_2)).toBe(true);
  });
});

describe("MarketplaceKitCliAdapter — binary resolution and failure mapping", () => {
  it("returns a clean typed CLI_NOT_FOUND error when no binary resolves (never npx)", async () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), "agenc-protocol-empty-"));
    const adapter = new MarketplaceKitCliAdapter({
      cliPath: join(emptyCwd, "does-not-exist"),
      cwd: emptyCwd,
      env: {}, // no AGENC_MARKETPLACE_CLI, no ambient leakage
    });

    const result = await adapter.listClaimable();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CLI_NOT_FOUND");
    expect(result.error.message).toContain("agenc-marketplace");
    expect(result.error.message).toContain("npx fallback is deliberately not supported");
  });

  it("resolves the binary from AGENC_MARKETPLACE_CLI when no cli_path override is set", async () => {
    const fixture = writeCliFixture();
    const emptyCwd = mkdtempSync(join(tmpdir(), "agenc-protocol-envres-"));
    const adapter = new MarketplaceKitCliAdapter({
      cwd: emptyCwd,
      env: { ...CLEAN_SPAWN_ENV, AGENC_MARKETPLACE_CLI: fixture.binPath },
    });

    const result = await adapter.listClaimable();
    expect(result.ok).toBe(true);
    expect(fixture.invocations()).toHaveLength(1);
  });

  it("maps success:false payloads to CLI_FAILED with sanitized error text", async () => {
    const fixture = writeCliFixture("failure");
    const adapter = adapterFor(fixture.binPath);

    const result = await adapter.listClaimable();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CLI_FAILED");
    // Untrusted error text is control-char-stripped before rendering.
    expect(result.error.message).not.toContain("\u001b");
  });

  it("maps non-JSON stdout to CLI_BAD_OUTPUT", async () => {
    const fixture = writeCliFixture("garbage");
    const adapter = adapterFor(fixture.binPath);

    const result = await adapter.taskDetail(FIXTURE_TASK_PDA_1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CLI_BAD_OUTPUT");
  });
});

/** Copy the fixture binary to `target`, creating its directory. */
function plantBinary(fixtureBin: string, target: string, mode = 0o755): void {
  mkdirSync(join(target, ".."), { recursive: true });
  copyFileSync(fixtureBin, target);
  chmodSync(target, mode);
}

describe("MarketplaceKitCliAdapter — binary location is never repository-controlled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not run node_modules/.bin/agenc-marketplace from the working directory", async () => {
    const fixture = writeCliFixture();
    const repo = mkdtempSync(join(tmpdir(), "agenc-protocol-planted-repo-"));
    const emptyHome = mkdtempSync(join(tmpdir(), "agenc-protocol-planted-home-"));
    plantBinary(fixture.binPath, join(repo, "node_modules", ".bin", "agenc-marketplace"));
    const adapter = new MarketplaceKitCliAdapter({
      cwd: repo,
      homeDir: emptyHome,
      env: CLEAN_SPAWN_ENV,
    });

    const list = await adapter.listClaimable();
    const detail = await adapter.taskDetail(FIXTURE_TASK_PDA_1);

    for (const result of [list, detail]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("CLI_NOT_FOUND");
      expect(result.error.message).toContain("never searched");
    }
    // The planted binary never ran.
    expect(fixture.invocations()).toEqual([]);
  });

  it("does not run a cwd binary even when the process also sits in that directory", async () => {
    const fixture = writeCliFixture();
    const repo = mkdtempSync(join(tmpdir(), "agenc-protocol-planted-cwd-"));
    plantBinary(fixture.binPath, join(repo, "node_modules", ".bin", "agenc-marketplace"));
    const emptyHome = mkdtempSync(join(tmpdir(), "agenc-protocol-planted-home2-"));
    const adapter = new MarketplaceKitCliAdapter({
      homeDir: emptyHome,
      env: CLEAN_SPAWN_ENV,
    });
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const result = await adapter.listClaimable();
      expect(result.ok).toBe(false);
    } finally {
      process.chdir(previous);
    }
    expect(fixture.invocations()).toEqual([]);
  });

  const posixOnly = typeof process.getuid === "function" ? it : it.skip;

  posixOnly("runs the installer's own ~/.agenc/bin/agenc-marketplace when it is trusted", async () => {
    const fixture = writeCliFixture();
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-installed-"));
    const installed = join(home, ".agenc", "bin", "agenc-marketplace");
    plantBinary(fixture.binPath, installed);
    chmodSync(join(home, ".agenc", "bin"), 0o755);

    expect(resolveInstalledKitBinary(home)).toBe(installed);
    const adapter = new MarketplaceKitCliAdapter({ homeDir: home, env: CLEAN_SPAWN_ENV });
    const result = await adapter.listClaimable();
    expect(result.ok).toBe(true);
    expect(fixture.invocations()).toHaveLength(1);
  });

  posixOnly("refuses an installed binary that is world-writable", async () => {
    const fixture = writeCliFixture();
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-ww-file-"));
    const installed = join(home, ".agenc", "bin", "agenc-marketplace");
    plantBinary(fixture.binPath, installed, 0o757);

    expect(resolveInstalledKitBinary(home)).toBeUndefined();
    const result = await new MarketplaceKitCliAdapter({
      homeDir: home,
      env: CLEAN_SPAWN_ENV,
    }).listClaimable();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLI_NOT_FOUND");
    expect(fixture.invocations()).toEqual([]);
  });

  posixOnly("refuses an installed binary in a world-writable directory", () => {
    const fixture = writeCliFixture();
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-ww-dir-"));
    plantBinary(fixture.binPath, join(home, ".agenc", "bin", "agenc-marketplace"));
    chmodSync(join(home, ".agenc", "bin"), 0o777);

    expect(resolveInstalledKitBinary(home)).toBeUndefined();
  });

  posixOnly("refuses an installed binary that another user owns", () => {
    const fixture = writeCliFixture();
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-foreign-"));
    plantBinary(fixture.binPath, join(home, ".agenc", "bin", "agenc-marketplace"));
    chmodSync(join(home, ".agenc", "bin"), 0o755);
    expect(resolveInstalledKitBinary(home)).toBeDefined();

    // As a different account, the same files are not ours.
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(resolveInstalledKitBinary(home)).toBeUndefined();
  });

  it("finds nothing when the installer's directory does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-no-install-"));
    expect(resolveInstalledKitBinary(home)).toBeUndefined();
  });

  posixOnly("prefers cli_path, then AGENC_MARKETPLACE_CLI, over the installed binary", async () => {
    const viaConfig = writeCliFixture();
    const viaEnv = writeCliFixture();
    const installedFixture = writeCliFixture();
    const home = mkdtempSync(join(tmpdir(), "agenc-protocol-precedence-"));
    plantBinary(installedFixture.binPath, join(home, ".agenc", "bin", "agenc-marketplace"));
    chmodSync(join(home, ".agenc", "bin"), 0o755);

    await new MarketplaceKitCliAdapter({
      cliPath: viaConfig.binPath,
      homeDir: home,
      env: { ...CLEAN_SPAWN_ENV, AGENC_MARKETPLACE_CLI: viaEnv.binPath },
    }).listClaimable();
    await new MarketplaceKitCliAdapter({
      homeDir: home,
      env: { ...CLEAN_SPAWN_ENV, AGENC_MARKETPLACE_CLI: viaEnv.binPath },
    }).listClaimable();

    expect(viaConfig.invocations()).toHaveLength(1);
    expect(viaEnv.invocations()).toHaveLength(1);
    expect(installedFixture.invocations()).toEqual([]);
  });
});

describe("MarketplaceKitCliAdapter — minimal child environment", () => {
  function envDumpBinary(): { readonly binPath: string; readonly dumpPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "agenc-protocol-env-"));
    const binPath = join(dir, "agenc-marketplace.cjs");
    const dumpPath = join(dir, "env.json");
    writeFileSync(
      binPath,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));
process.stdout.write(JSON.stringify({ success: true, tasks: [] }));
`,
      "utf8",
    );
    chmodSync(binPath, 0o755);
    return { binPath, dumpPath };
  }

  it("passes the child only the allowlisted variables, never secrets", async () => {
    const { binPath, dumpPath } = envDumpBinary();
    const adapter = new MarketplaceKitCliAdapter({
      cliPath: binPath,
      env: {
        PATH: process.env.PATH,
        HOME: "/home/user",
        LANG: "en_US.UTF-8",
        https_proxy: "http://proxy.local:3128",
        AGENC_RPC_URL: "https://rpc.example/v1",
        AGENC_MARKETPLACE_CLI: binPath,
        OPENAI_API_KEY: "sk-must-not-leak",
        ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
        AGENC_WALLET: "/home/user/wallet.json",
        AGENC_WALLET_VAULT_PASSPHRASE: "passphrase-must-not-leak",
        AGENC_UNATTENDED_AUTONOMOUS: "1",
        GITHUB_TOKEN: "ghp_must_not_leak",
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      },
    });

    const result = await adapter.listClaimable();
    expect(result.ok).toBe(true);

    const childEnv = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, string>;
    expect(childEnv.HOME).toBe("/home/user");
    expect(childEnv.https_proxy).toBe("http://proxy.local:3128");
    expect(childEnv.AGENC_RPC_URL).toBe("https://rpc.example/v1");
    expect(childEnv.PATH).toBe(process.env.PATH);
    const allowed = new Set(CLI_ENV_ALLOWLIST);
    for (const key of Object.keys(childEnv)) {
      // The runtime may add a few of its own (for example __CF_USER_TEXT_ENCODING
      // on macOS); nothing from the session environment beyond the allowlist.
      if (!allowed.has(key.toUpperCase())) {
        expect(
          ["__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_", "OLDPWD"],
          `unexpected variable ${key}`,
        ).toContain(key);
      }
    }
    for (const leaked of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AGENC_WALLET",
      "AGENC_WALLET_VAULT_PASSPHRASE",
      "AGENC_UNATTENDED_AUTONOMOUS",
      "AGENC_MARKETPLACE_CLI",
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(childEnv, leaked).not.toHaveProperty(leaked);
    }
  });

  it("minimalCliEnv keeps case-insensitive matches and drops unset and unknown names", () => {
    expect(
      minimalCliEnv({
        Path: "C:\\bin",
        SystemRoot: "C:\\Windows",
        HOME: "/h",
        EMPTY: undefined,
        SECRET_TOKEN: "x",
      }),
    ).toEqual({ Path: "C:\\bin", SystemRoot: "C:\\Windows", HOME: "/h" });
    expect(minimalCliEnv({})).toEqual({});
  });

  it("allowlists no credential-shaped names", () => {
    for (const name of CLI_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASS|WALLET|SIGNER|POLICY|NODE_OPTIONS|PRELOAD|INSERT/i);
    }
  });
});

describe("MarketplaceKitCliAdapter — mutating verbs stay owner-gated", () => {
  it("returns VERB_NOT_ENABLED (owner approval) for every mutating verb, spawning nothing", async () => {
    const fixture = writeCliFixture();
    const adapter = adapterFor(fixture.binPath);

    const results = await Promise.all([
      adapter.claimTask(FIXTURE_TASK_PDA_1),
      adapter.delegateStep("agent", "step"),
      adapter.submitProof("target"),
      adapter.settleTask(FIXTURE_TASK_PDA_1),
      adapter.adjustStake("100"),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("VERB_NOT_ENABLED");
      expect(result.error.message).toContain("owner approval");
      expect(result.error.message).toContain("read-only");
    }
    expect(fixture.invocations()).toEqual([]);
  });
});

describe("protocol transport factory (A1)", () => {
  it("builds the sole active marketplace-cli adapter", () => {
    expect(
      createProtocolTransport({ enabled: true, adapter: "marketplace-cli" }).kind,
    ).toBe("marketplace-cli");
  });
});

describe("sanitizeUntrustedText", () => {
  it("strips control characters and truncates", () => {
    expect(sanitizeUntrustedText("a\u001b[31mb c\nd")).toBe("a [31mb c d");
    const long = "x".repeat(500);
    const sanitized = sanitizeUntrustedText(long, 100);
    expect(sanitized.length).toBe(101); // 100 chars + ellipsis
    expect(sanitized.endsWith("…")).toBe(true);
  });
});
