import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("./TrustDialog.tsx", import.meta.url),
  "utf8",
);

describe("TrustDialog command sources", () => {
  test("uses current skill command sources for bash trust checks", () => {
    expect(source).not.toContain("commands_DEPRECATED");
    expect(source).toContain('command.loadedFrom === "skills"');
  });

  test("does not schedule accepted-state completion during render", () => {
    expect(source).not.toContain("setTimeout(onDone)");
    expect(source).toContain("if (!hasTrustDialogAccepted)");
    expect(source).toContain("onDone();");
  });
});
