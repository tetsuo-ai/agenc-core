/**
 * A session created with a `toolPolicy` has a fixed tool surface and works
 * through untrusted content, so the AgenC protocol commands (`/claim`,
 * `/delegate`, `/proof`, `/settle`, `/stake`) and the marketplace CLI adapter
 * behind them must not run in it, whatever the operator's `[protocol]` block
 * says. A fake `agenc-marketplace` binary records every spawn, so "never runs"
 * is checked against actual process starts.
 */

import { describe, expect, it } from "vitest";

import { protocolCommands } from "../../src/commands/protocol.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import { normalizeSessionToolPolicy } from "../../src/permissions/session-tool-policy.js";
import { FIXTURE_TASK_PDA_1, writeCliFixture } from "../protocol/fixture.js";

const VERBS = ["claim", "delegate", "proof", "settle", "stake"] as const;

function ctxFor(
  binPath: string,
  options: { readonly policy?: ReturnType<typeof normalizeSessionToolPolicy>; readonly argsRaw?: string },
): SlashCommandContext {
  const base = mergeConfigs(defaultConfig(), {
    protocol: { enabled: true, adapter: "marketplace-cli", cli_path: binPath },
  } as Partial<AgenCConfig>);
  return {
    session: {
      services: {
        registry: options.policy === undefined ? {} : { toolPolicy: options.policy },
      },
    } as unknown as SlashCommandContext["session"],
    argsRaw: options.argsRaw ?? "",
    cwd: "/tmp",
    home: "/home/test",
    configStore: new ConfigStore({ base, env: {} }),
  };
}

function command(name: (typeof VERBS)[number]) {
  const found = protocolCommands.find((c) => c.name === name);
  if (found === undefined) throw new Error(`protocol command not registered: ${name}`);
  return found;
}

describe("protocol commands in a session with a toolPolicy", () => {
  const policy = normalizeSessionToolPolicy({ enabledTools: ["FileRead"] });

  it.each(VERBS)("/%s is refused and spawns nothing, even with the transport configured", async (verb) => {
    const fixture = writeCliFixture();
    const result = await command(verb).execute(
      ctxFor(fixture.binPath, {
        policy,
        argsRaw: verb === "claim" ? FIXTURE_TASK_PDA_1 : "some-args",
      }),
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain(`AgenC protocol · ${verb}`);
    expect(result.message).toContain("not available in a session with a toolPolicy");
    expect(result.message).toContain("No command was executed");
    expect(fixture.invocations()).toEqual([]);
  });

  it("/claim without a PDA does not list tasks either", async () => {
    const fixture = writeCliFixture();
    const result = await command("claim").execute(ctxFor(fixture.binPath, { policy }));
    expect(result.kind).toBe("error");
    expect(fixture.invocations()).toEqual([]);
  });

  it("refuses before reading config: a session with a policy needs no configStore", async () => {
    const result = await command("claim").execute({
      session: { services: { registry: { toolPolicy: policy } } } as unknown as SlashCommandContext["session"],
      argsRaw: "",
      cwd: "/tmp",
      home: "/home/test",
    });
    expect(result.kind).toBe("error");
  });

  it("leaves a session without a policy unchanged", async () => {
    const fixture = writeCliFixture();
    const result = await command("claim").execute(ctxFor(fixture.binPath, {}));
    expect(result.kind).toBe("text");
    expect(fixture.invocations()).toHaveLength(1);
  });
});
