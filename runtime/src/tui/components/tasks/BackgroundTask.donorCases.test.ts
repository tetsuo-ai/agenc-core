import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backgroundTaskSource = readFileSync(
  new URL("./BackgroundTask.tsx", import.meta.url),
  "utf8",
);

describe("BackgroundTask shipped task surface", () => {
  it("does not render dropped donor-only task kinds", () => {
    for (const droppedType of ["local_workflow", "monitor_mcp", "dream"]) {
      expect(backgroundTaskSource).not.toContain(`case "${droppedType}"`);
      expect(backgroundTaskSource).not.toContain(`case '${droppedType}'`);
    }
  });
});
