/**
 * Contract test for the AgenC protocol slash commands
 * (`/claim`, `/delegate`, `/proof`, `/settle`, `/stake`).
 *
 * Scope decision (locked in by this test): unlike `/model`,
 * `/permissions`, `/plan`, and `/compact` — which are daemon-dispatch
 * gaps where a real capability already lives inside the running agent
 * session and only the bridge forwarder is missing — the protocol verbs
 * have NO backend at any layer. There is no `protocol.*` daemon RPC, no
 * on-chain client (no `@solana/web3.js`, no Anchor program, no wallet/
 * RPC), and no producer for the `protocol_*` event scaffolding. They are
 * honest, local, immediate placeholders for an unbuilt on-chain
 * marketplace feature.
 *
 * This test pins that end state: the commands register cleanly, declare
 * both surfaces, execute locally without throwing, and return an honest
 * "not attached yet" text result on the daemon-backed path. It exists so
 * that if someone later wires a dead `protocol.*` forwarder (strictly
 * worse than the current honest text), or the commands start crashing,
 * the regression is caught here.
 */

import { describe, expect, it } from "vitest";

import { protocolCommands } from "./protocol.js";
import type {
  SlashCommand,
  SlashCommandContext,
} from "./types.js";

const VERBS = ["claim", "delegate", "proof", "settle", "stake"] as const;

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

function byName(name: string): SlashCommand {
  const cmd = protocolCommands.find((c) => c.name === name);
  if (cmd === undefined) {
    throw new Error(`protocol command not registered: ${name}`);
  }
  return cmd;
}

describe("protocol slash commands (contract)", () => {
  it("registers exactly the five protocol verbs", () => {
    expect(protocolCommands.map((c) => c.name).sort()).toEqual(
      [...VERBS].sort(),
    );
  });

  it("declares both the runtime and daemon-tui surfaces", () => {
    for (const verb of VERBS) {
      const cmd = byName(verb);
      expect(cmd.supportedSurfaces).toEqual(["runtime", "daemon-tui"]);
      expect(cmd.userInvocable).toBe(true);
      expect(cmd.immediate).toBe(true);
    }
  });

  it("executes locally without throwing and returns honest placeholder text on the daemon path", async () => {
    for (const verb of VERBS) {
      const cmd = byName(verb);
      const res = await cmd.execute(makeCtx());
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        // Honest "no backend attached" message — NOT an error box and
        // NOT a faked on-chain result.
        expect(res.text).toContain("Protocol transport is not attached");
        expect(res.text).toContain(`AgenC protocol · ${verb}`);
      }
    }
  });

  it("echoes user arguments without attempting any on-chain dispatch", async () => {
    const res = await byName("claim").execute(
      makeCtx({ argsRaw: "  TaskPda111  " }),
    );
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Requested: claim TaskPda111");
      // Still the honest placeholder — args do not unlock a real path.
      expect(res.text).toContain("Protocol transport is not attached");
    }
  });

  it("never throws (safeExecute contract) even with hostile context", async () => {
    for (const verb of VERBS) {
      const cmd = byName(verb);
      // Missing/odd argsRaw must not crash the local executor.
      const res = await cmd.execute(
        makeCtx({ argsRaw: undefined as unknown as string }),
      );
      expect(["text", "error"]).toContain(res.kind);
    }
  });
});
