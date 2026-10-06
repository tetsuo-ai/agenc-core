import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryMaintenancePermissionCheck } from "../../../src/services/autoDream/maintenance-permissions.js";
import { createAutoMemoryToolPolicy } from "../../../src/services/extractMemories/extractMemories.js";
import { ConfigStore } from "../../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import { PermissionModeRegistry } from "../../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import { applyPermissionUpdate } from "../../../src/permissions/permission-updates.js";
import type { Session } from "../../../src/session/session.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("noninteractive consolidation permission authority", () => {
  it.each(["allow", "ask", "deny", "outside"] as const)("intersects memory scope with %s policy", async (behavior) => {
    root = await mkdtemp(join(tmpdir(), "agenc-memory-permission-"));
    const cwd = join(root, "repo");
    const memory = join(root, ".agenc", "memory");
    await mkdir(cwd, { recursive: true });
    await mkdir(memory, { recursive: true });
    const target = join(behavior === "outside" ? cwd : memory, "feedback.md");
    const store = new ConfigStore({ home: join(root, ".agenc"), cwd,
      cliOverrides: { autoMemoryEnabled: true, autoMemoryDirectory: memory } });
    await store.reload();
    let permissions = createEmptyToolPermissionContext();
    if (behavior === "ask" || behavior === "deny") {
      permissions = applyPermissionUpdate(permissions, { type: "addRules", destination: "session", behavior,
        rules: [{ toolName: "Write", ruleContent: target }] });
    }
    const session = { permissionModeRegistry: new PermissionModeRegistry(permissions),
      services: { registry: { tools: [createFileWriteTool({ allowedPaths: [cwd] })] } },
    } as unknown as Session;
    const deferred = vi.fn();
    const permission = createMemoryMaintenancePermissionCheck(createAutoMemoryToolPolicy(memory), session, deferred);
    const decision = await runWithCanonicalSettingsAuthority(store, () => permission(
      { name: "Write" } as never, { file_path: target, content: "Prefer concise responses." },
      {} as never, {} as never, "memory-call",
    ));
    expect(decision.behavior).toBe(behavior === "allow" ? "allow" : "deny");
    if (behavior === "ask") expect(deferred).toHaveBeenCalledWith("Write");
    else expect(deferred).not.toHaveBeenCalled();
  });
});
