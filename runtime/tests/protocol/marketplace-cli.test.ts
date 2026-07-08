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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MarketplaceKitCliAdapter } from "../../src/protocol/marketplace-cli.js";
import { NullTransport } from "../../src/protocol/null-transport.js";
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

describe("NullTransport and factory defaults (A1)", () => {
  it("NullTransport read verbs report TRANSPORT_NOT_CONFIGURED", async () => {
    const transport = new NullTransport();
    const list = await transport.listClaimable();
    const detail = await transport.taskDetail(FIXTURE_TASK_PDA_1);
    for (const result of [list, detail]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("TRANSPORT_NOT_CONFIGURED");
    }
  });

  it("NullTransport mutating verbs report VERB_NOT_ENABLED", async () => {
    const transport = new NullTransport();
    const results = await Promise.all([
      transport.claimTask(FIXTURE_TASK_PDA_1),
      transport.delegateStep("agent", "step"),
      transport.submitProof(),
      transport.settleTask(),
      transport.adjustStake(),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("VERB_NOT_ENABLED");
      expect(result.error.message).toContain("owner approval");
    }
  });

  it("createProtocolTransport only builds the CLI adapter for an explicit enabled marketplace-cli block", () => {
    expect(createProtocolTransport(undefined).kind).toBe("null");
    expect(createProtocolTransport({}).kind).toBe("null");
    expect(createProtocolTransport({ enabled: false }).kind).toBe("null");
    expect(
      createProtocolTransport({ enabled: true, adapter: "null" }).kind,
    ).toBe("null");
    expect(
      createProtocolTransport({ enabled: false, adapter: "marketplace-cli" }).kind,
    ).toBe("null");
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
