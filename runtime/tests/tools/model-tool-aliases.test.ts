import { describe, expect, test } from "vitest";
import { resolveModelToolAlias } from "../../src/tools/model-tool-aliases.js";

describe("exact model tool aliases", () => {
  test.each([
    ["Read", "FileRead"], ["read_file", "FileRead"],
    ["write_file", "Write"], ["edit_file", "Edit"],
    ["Bash", "system.bash"], ["grep", "Grep"],
    ["glob", "Glob"], ["LS", "system.listDir"],
  ])("resolves %s only when %s exists", (alias, canonical) => {
    expect(resolveModelToolAlias(alias, [canonical])).toBe(canonical);
    expect(resolveModelToolAlias(alias, [])).toBe(alias);
  });

  test("preserves exact registered names and rejects fuzzy or ambiguous names", () => {
    expect(resolveModelToolAlias("Read", ["Read", "FileRead"])).toBe("Read");
    expect(resolveModelToolAlias("Write", ["Write"])).toBe("Write");
    expect(resolveModelToolAlias("Bash", ["exec_command"])).toBe("Bash");
    for (const name of ["UnknownMystery", "Read ", "Reed", "mcp.Read", "search", "__proto__"]) {
      expect(resolveModelToolAlias(name, ["FileRead", "Grep", "Glob"])).toBe(name);
    }
  });
});
