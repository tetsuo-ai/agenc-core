import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentControl } from "src/agents/control";
import { AgentRegistry } from "src/agents/registry";
import {
  createAgentRoleWorkspace,
  registerAgentRole,
  _resetAgentRolesForTesting,
  _resetNicknamePoolForTesting,
} from "src/agents/role";

// gaphunt3 #46: a nickname freshly allocated during spawn leaks into the
// registry's usedNicknames pool when the spawn rolls back (e.g. the I-32
// parent-interrupt race). reservation.release() rolls back the slot + path
// but NOT the nickname; the catch block must release it. These tests assert
// the rolled-back nickname returns to the pool (and is reusable).

const LEAK_ROLE = "gaphunt3-leak-role";

let agencHome = "";
let originalAgencHome = "";

function stubSession(): ConstructorParameters<typeof AgentControl>[0]["session"] {
  const emitted: unknown[] = [];
  return {
    emit: (e: unknown) => {
      emitted.push(e);
    },
    eventLog: {
      emit: (e: unknown) => {
        emitted.push(e);
        return e;
      },
    },
    nextInternalSubId: () => `sub-${emitted.length}`,
    childInboxes: new Map(),
    rolloutStore: null,
    conversationId: "gaphunt3-control",
    sessionConfiguration: { cwd: agencHome },
    _emitted: emitted,
  } as unknown as ConstructorParameters<typeof AgentControl>[0]["session"];
}

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-gh3-control-"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = agencHome;
  _resetNicknamePoolForTesting();
  // Two candidates so there is always exactly one free name to allocate for
  // the grandchild after the live child has taken the first.
  registerAgentRole(createAgentRoleWorkspace(agencHome), {
    name: LEAK_ROLE,
    config: { nicknameCandidates: ["scout", "ranger"] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetAgentRolesForTesting();
  _resetNicknamePoolForTesting();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  if (agencHome) rmSync(agencHome, { recursive: true, force: true });
});

describe("gaphunt3 #46 — spawn rollback releases a freshly allocated nickname", () => {
  it("releases the nickname when the I-32 parent-interrupt race aborts the spawn", async () => {
    // Deterministic allocation: always pick available[0].
    vi.spyOn(Math, "random").mockReturnValue(0);

    const session = stubSession();
    const registry = new AgentRegistry();
    const control = new AgentControl({ session, registry, maxDepth: 3 });

    // Parent child takes "scout" and registers a per-agent parent token.
    const child = await control.spawn({
      parentPath: "/root",
      roleName: LEAK_ROLE,
    });
    expect(child.nickname).toBe("scout");
    expect(registry.hasNickname("scout")).toBe(true);

    // Interrupt the child so its parent token is aborted; spawning a
    // grandchild under it will hit the I-32 abort race after the
    // grandchild's nickname ("ranger") has already been allocated.
    control.interrupt(child.agentId, "stop");
    expect(child.abortController.signal.aborted).toBe(true);

    await expect(
      control.spawn({
        parentPath: child.agentPath,
        roleName: LEAK_ROLE,
      }),
    ).rejects.toThrow(/interrupted mid-spawn/);

    // The grandchild's freshly allocated nickname must NOT remain reserved.
    // Before the fix it leaks (stays in usedNicknames); after the fix it is
    // released back into the pool.
    expect(registry.hasNickname("ranger")).toBe(false);

    // And it must be reusable: a subsequent successful spawn under a
    // non-aborted parent re-allocates the released name.
    const sibling = await control.spawn({
      parentPath: "/root",
      roleName: LEAK_ROLE,
    });
    expect(sibling.nickname).toBe("ranger");
  });
});
