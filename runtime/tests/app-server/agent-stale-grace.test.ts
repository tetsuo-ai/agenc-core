import { describe, expect, test } from "vitest";
import { isStaleAgent } from "../../src/app-server/agent-lifecycle.js";

const base = {
  status: "working",
  recovered: false,
  runtimeAvailable: false,
} as never;

describe("stale-agent grace window", () => {
  const cases: readonly {
    readonly name: string;
    readonly agent: Record<string, unknown>;
    readonly at: string;
    readonly stale: boolean;
  }[] = [
    {
      name: "a transient null snapshot never reaps a live agent",
      agent: { runtimeUnavailableSince: "2026-08-31T10:00:00.000Z" },
      at: "2026-08-31T10:00:05.000Z",
      stale: false,
    },
    {
      name: "unavailability without a start stamp is not reapable",
      agent: {},
      at: "2026-08-31T10:10:00.000Z",
      stale: false,
    },
    {
      name: "persistent unavailability past the grace window is reapable",
      agent: { runtimeUnavailableSince: "2026-08-31T10:00:00.000Z" },
      at: "2026-08-31T10:01:30.000Z",
      stale: true,
    },
    {
      name: "a recovery without runtime stays immediately reapable",
      agent: { recovered: true },
      at: "2026-08-31T10:00:00.500Z",
      stale: true,
    },
    {
      name: "an available runtime is never stale",
      agent: { runtimeAvailable: true },
      at: "2026-08-31T10:10:00.000Z",
      stale: false,
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const agent = { ...(base as object), ...item.agent } as never;
      expect(isStaleAgent(agent, item.at)).toBe(item.stale);
    });
  }
});
