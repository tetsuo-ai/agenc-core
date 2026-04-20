import { describe, expect, test } from "vitest";
import { buildToolRegistry } from "./tool-registry.js";

describe("T7 tool-registry ConcurrencyClass tagging", () => {
  test("read-only fs tools get SharedRead + isReadOnly=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const readFile = registry.tools.find((t) => t.name === "system.readFile");
    expect(readFile?.concurrencyClass?.kind).toBe("shared_read");
    expect(readFile?.isReadOnly).toBe(true);
    expect(readFile?.supportsParallelToolCalls).toBe(true);
  });

  test("write fs tools get Exclusive + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const writeFile = registry.tools.find((t) => t.name === "system.writeFile");
    expect(writeFile?.concurrencyClass?.kind).toBe("exclusive");
    expect(writeFile?.requiresApproval).toBe(true);
    expect(writeFile?.supportsParallelToolCalls).toBe(false);
  });

  test("bash tool gets BackgroundTerminal + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const bash = registry.tools.find((t) => t.name === "system.bash");
    expect(bash?.concurrencyClass?.kind).toBe("background_terminal");
    expect(bash?.requiresApproval).toBe(true);
  });
});
