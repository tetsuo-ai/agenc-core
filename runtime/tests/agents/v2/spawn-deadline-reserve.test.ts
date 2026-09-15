import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import { setRunDeadlineClockForTests } from "../../../src/session/run-deadline.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import { mkSession } from "../../fixtures.js";
import { createFakeRunDeadlineClock } from "../../helpers/fake-run-deadline-clock.js";

afterEach(() => {
  setRunDeadlineClockForTests(null);
  vi.restoreAllMocks();
});

/** A run in its deadline reserve (#2503) finishes instead of delegating. */
describe("spawn_agent in the deadline reserve", () => {
  function spawnTool(remainingMs: number) {
    const clock = createFakeRunDeadlineClock();
    setRunDeadlineClockForTests(clock);
    const { session } = mkSession({
      services: {
        runtimeOptions: resolveAgentRuntimeOptions({}, {
          nonInteractive: true,
          deadlineAt: clock.now() + remainingMs,
          deadlineReserveMs: 60_000,
        }),
      },
    });
    const opts = {
      getSession: () => session,
      workspace: session.roleWorkspace,
      roleCatalog: new AgentRoleCatalog(session.roleWorkspace),
      ensureAgentControl: () => ({
        control: { roleWorkspace: session.roleWorkspace, assertRoleWorkspace: () => {} },
        registry: {},
      }),
    } as unknown as MultiAgentV2Options;
    return createSpawnAgentTool(opts);
  }

  it("refuses with a confirmed-no-effect result and never delegates", async () => {
    const result = await spawnTool(30_000).execute({ message: "help", task_name: "helper" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("deadline reserve");
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
    });
    expect(vi.mocked(delegate)).not.toHaveBeenCalled();
  });

  it("is not refused before the reserve", async () => {
    vi.mocked(delegate).mockRejectedValue(new Error("delegate reached"));
    const result = await spawnTool(10 * 60_000).execute({ message: "help", task_name: "helper" });

    expect(String(result.content)).not.toContain("deadline reserve");
    expect(vi.mocked(delegate)).toHaveBeenCalled();
  });
});
