import { describe, expect, test } from "vitest";

import { swarmCommand } from "../../src/commands/swarm.js";
import { swarmModeProducer } from "../../src/prompts/attachments/swarm-mode.js";
import {
  getSettingsForSource,
  updateSettingsForSource,
} from "../../src/utils/settings/settings.js";

function makeCtx(argsRaw: string) {
  const appState = {
    state: { swarmMode: false as boolean | undefined },
    getAppState() {
      return this.state;
    },
    setAppState(updater: (prev: unknown) => unknown) {
      this.state = updater(this.state) as typeof this.state;
    },
  };
  return { argsRaw, appState } as never;
}

describe("/swarm command", () => {
  test("status reports the current mode and usage hint", async () => {
    updateSettingsForSource("userSettings", { swarmMode: undefined });
    const result = (await swarmCommand.execute(makeCtx("status"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("swarm mode: off");
    expect(result.text).toContain("/swarm on");
  });

  test("on enables swarm mode in settings and AppState", async () => {
    const ctx = makeCtx("on") as {
      appState: { state: { swarmMode?: boolean } };
    };
    const result = (await swarmCommand.execute(ctx as never)) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(ctx.appState.state.swarmMode).toBe(true);
    expect(getSettingsForSource("userSettings")?.swarmMode).toBe(true);
  });

  test("off disables swarm mode again", async () => {
    const ctx = makeCtx("off") as {
      appState: { state: { swarmMode?: boolean } };
    };
    const result = (await swarmCommand.execute(ctx as never)) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(ctx.appState.state.swarmMode).toBe(false);
    expect(getSettingsForSource("userSettings")?.swarmMode).toBe(false);
  });

  test("rejects unknown arguments", async () => {
    const result = (await swarmCommand.execute(makeCtx("maybe"))) as {
      kind: string;
      message: string;
    };
    expect(result.kind).toBe("error");
    expect(result.message).toContain("Usage");
  });
});

describe("swarmModeProducer", () => {
  const opts = { subagentDepth: 0 } as never;
  const childOpts = { subagentDepth: 1 } as never;

  test("emits the parallel fan-out nudge while swarm mode is on", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const attachments = await swarmModeProducer(opts, {} as never);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "critical_system_reminder",
    });
    expect(
      (attachments[0] as { content?: string }).content ?? "",
    ).toContain("Swarm mode is active");
  });

  test("emits nothing when swarm mode is off", async () => {
    updateSettingsForSource("userSettings", { swarmMode: false });
    expect(await swarmModeProducer(opts, {} as never)).toEqual([]);
  });

  test("emits nothing on swarm children (no recursive fan-out)", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    expect(await swarmModeProducer(childOpts, {} as never)).toEqual([]);
  });
});
