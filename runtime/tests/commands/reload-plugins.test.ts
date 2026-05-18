import { describe, expect, it } from "vitest";

import { builtInCommandNames, listTuiCommandList } from "../commands.js";
import { buildDefaultRegistry } from "./registry.js";

describe("removed /reload-plugins slash surface", () => {
  it("is absent from the registry, TUI list, and built-in name set", () => {
    expect(buildDefaultRegistry().has("reload-plugins")).toBe(false);
    expect(listTuiCommandList().map((command) => command.name)).not.toContain(
      "reload-plugins",
    );
    expect(builtInCommandNames().has("reload-plugins")).toBe(false);
  });
});
