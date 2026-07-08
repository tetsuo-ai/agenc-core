/**
 * A1/A2 — `/claim` protocol transport wiring through the slash-command
 * path, driven by a fake `agenc-marketplace` binary
 * (`tests/protocol/fixture.ts`).
 *
 * Pins four things:
 *   1. Revert-safe default: with `[protocol]` absent, disabled, or on
 *      the "null" adapter, every verb returns EXACTLY the historical
 *      "transport is not attached" stub text.
 *   2. Enabled marketplace-cli transport: `/claim` lists claimable
 *      tasks; `/claim <PDA>` shows task detail — both read-only, both
 *      through the fixture binary, with untrusted text sanitized.
 *   3. Hostile `/claim` arguments (shell metacharacters, flag
 *      smuggling) are rejected BEFORE any process is spawned.
 *   4. Mutating verbs stay owner-gated even with a transport attached.
 */

import { describe, expect, it } from "vitest";

import { protocolCommands } from "../../src/commands/protocol.js";
import type {
  SlashCommand,
  SlashCommandContext,
} from "../../src/commands/types.js";
import type { AgenCConfig, ProtocolConfig } from "../../src/config/schema.js";
import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  FIXTURE_TASK_PDA_1,
  FIXTURE_TASK_PDA_2,
  writeCliFixture,
  type CliFixture,
} from "../protocol/fixture.js";

function byName(name: string): SlashCommand {
  const cmd = protocolCommands.find((c) => c.name === name);
  if (cmd === undefined) {
    throw new Error(`protocol command not registered: ${name}`);
  }
  return cmd;
}

function storeWith(protocol?: ProtocolConfig): ConfigStore {
  const base =
    protocol === undefined
      ? defaultConfig()
      : mergeConfigs(defaultConfig(), { protocol } as Partial<AgenCConfig>);
  return new ConfigStore({ base, env: {} });
}

function makeCtx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    session: {} as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp",
    home: "/home/test",
    ...overrides,
  };
}

function ctxWithTransport(
  fixture: CliFixture,
  argsRaw = "",
): SlashCommandContext {
  return makeCtx({
    argsRaw,
    configStore: storeWith({
      enabled: true,
      adapter: "marketplace-cli",
      cli_path: fixture.binPath,
    }),
  });
}

/** The exact historical stub text (revert-safe default contract). */
function legacyStubText(verb: string, description: string, usageLine: string): string {
  return [
    `AgenC protocol · ${verb}`,
    description,
    `Usage: ${usageLine}`,
    "",
    "Protocol transport is not attached to this runtime yet; this command is registered for the TUI protocol surface and will emit protocol_* events once the on-chain client is configured.",
  ].join("\n");
}

describe("/claim transport wiring — revert-safe defaults", () => {
  it("returns the exact historical stub text with no configStore at all", async () => {
    const res = await byName("claim").execute(makeCtx());
    expect(res).toEqual({
      kind: "text",
      text: legacyStubText(
        "claim",
        "Claim an open task from the AgenC marketplace",
        "/claim <task-pda>",
      ),
    });
  });

  it("returns the exact historical stub text with the default (protocol-less) config", async () => {
    const res = await byName("claim").execute(
      makeCtx({ configStore: storeWith() }),
    );
    expect(res).toEqual({
      kind: "text",
      text: legacyStubText(
        "claim",
        "Claim an open task from the AgenC marketplace",
        "/claim <task-pda>",
      ),
    });
  });

  it("keeps the stub for enabled=false and for the null adapter", async () => {
    for (const protocol of [
      { enabled: false, adapter: "marketplace-cli" },
      { enabled: true, adapter: "null" },
      { enabled: true },
    ] as const) {
      const res = await byName("claim").execute(
        makeCtx({ configStore: storeWith(protocol as ProtocolConfig) }),
      );
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toContain("Protocol transport is not attached");
      }
    }
  });

  it("keeps the stub for every other verb when disabled", async () => {
    for (const verb of ["delegate", "proof", "settle", "stake"]) {
      const res = await byName(verb).execute(
        makeCtx({ configStore: storeWith() }),
      );
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toContain("Protocol transport is not attached");
      }
    }
  });
});

describe("/claim transport wiring — enabled marketplace-cli adapter", () => {
  it("/claim with no args lists claimable tasks (read-only) through the CLI", async () => {
    const fixture = writeCliFixture();
    const res = await byName("claim").execute(ctxWithTransport(fixture));

    expect(res.kind).toBe("text");
    if (res.kind !== "text") return;
    expect(res.text).toContain("claimable mainnet tasks (read-only)");
    expect(res.text).toContain(FIXTURE_TASK_PDA_1);
    expect(res.text).toContain(FIXTURE_TASK_PDA_2);
    expect(res.text).toContain("reward=0.5 SOL");
    expect(res.text).toContain("Wallet/signing/mutation used: No.");
    // Untrusted description rendered sanitized — no ANSI escape bytes.
    expect(res.text).not.toContain("\u001b");

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
  });

  it("/claim <PDA> fetches task detail (read-only) through the CLI", async () => {
    const fixture = writeCliFixture();
    const res = await byName("claim").execute(
      ctxWithTransport(fixture, `  ${FIXTURE_TASK_PDA_1}  `),
    );

    expect(res.kind).toBe("text");
    if (res.kind !== "text") return;
    expect(res.text).toContain("task detail (read-only)");
    expect(res.text).toContain(`Task PDA: ${FIXTURE_TASK_PDA_1}`);
    expect(res.text).toContain("Status: open");
    expect(res.text).toContain("Reward: 0.5 SOL");
    expect(res.text).toContain(
      "Moderation: status=clear, riskScore=3, advisoryOnly=true, hardBoundary=false",
    );
    expect(res.text).toContain("Wallet/signing/mutation used: No.");
    expect(res.text).not.toContain("\u001b");

    expect(fixture.invocations()).toEqual([
      ["--network", "mainnet", "--json", "explorer", "task", FIXTURE_TASK_PDA_1],
    ]);
  });

  it("rejects hostile /claim arguments before any process is spawned", async () => {
    const fixture = writeCliFixture();
    for (const hostile of [
      "abc; rm -rf /",
      "$(reboot)",
      "--yes",
      "'quoted'",
      "So11111111111111111111111111111111111111112 --yes",
    ]) {
      const res = await byName("claim").execute(
        ctxWithTransport(fixture, hostile),
      );
      expect(res.kind).toBe("error");
      if (res.kind === "error") {
        expect(res.message).toContain("invalid task PDA");
        expect(res.message).toContain("No command was executed");
      }
    }
    expect(fixture.invocations()).toEqual([]);
  });

  it("surfaces a clean typed error when the configured binary is missing", async () => {
    // The command path resolves via process.env as a fallback source;
    // strip any ambient AGENC_MARKETPLACE_CLI so a real installed kit
    // binary on the host can never be picked up by this test.
    const savedEnvCli = process.env.AGENC_MARKETPLACE_CLI;
    delete process.env.AGENC_MARKETPLACE_CLI;
    try {
      await runMissingBinaryCase();
    } finally {
      if (savedEnvCli !== undefined) {
        process.env.AGENC_MARKETPLACE_CLI = savedEnvCli;
      }
    }
  });

  async function runMissingBinaryCase(): Promise<void> {
    const res = await byName("claim").execute(
      makeCtx({
        configStore: storeWith({
          enabled: true,
          adapter: "marketplace-cli",
          cli_path: "/nonexistent/agenc-marketplace",
        }),
        // cwd without a node_modules/.bin fallback
        cwd: "/",
      }),
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toContain("CLI_NOT_FOUND");
    }
  }

  it("keeps mutating verbs owner-gated with the transport attached, spawning nothing", async () => {
    const fixture = writeCliFixture();
    for (const verb of ["delegate", "proof", "settle", "stake"]) {
      const res = await byName(verb).execute(
        ctxWithTransport(fixture, "some-args"),
      );
      expect(res.kind).toBe("text");
      if (res.kind !== "text") continue;
      expect(res.text).toContain(
        "Protocol transport is attached (read-only marketplace-cli adapter)",
      );
      expect(res.text).toContain("owner-gated");
      expect(res.text).toContain("VERB_NOT_ENABLED");
      expect(res.text).toContain("Wallet/signing/mutation used: No.");
      // No fake success, no legacy "not attached" lie either.
      expect(res.text).not.toContain("Protocol transport is not attached");
    }
    expect(fixture.invocations()).toEqual([]);
  });
});
