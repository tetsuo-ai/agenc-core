import { describe, expect, it } from "vitest";
import { marketplaceTwinOwner } from "../../src/commands.js";

const enabled = new Set(["zeroday-hunter", "iot-builder"]);

describe("marketplaceTwinOwner", () => {
  it("shadows a bundled skill whose name matches an enabled plugin", () => {
    expect(
      marketplaceTwinOwner({ name: "iot-builder", source: "bundled" }, enabled),
    ).toBe("iot-builder");
    expect(
      marketplaceTwinOwner({ name: "IoT-Builder", source: "bundled" }, enabled),
    ).toBe("iot-builder");
  });

  it("shadows builtin plugin commands owned by an enabled plugin", () => {
    expect(
      marketplaceTwinOwner(
        { name: "zeroday-hunter", source: "zeroday-hunter@builtin" },
        enabled,
      ),
    ).toBe("zeroday-hunter");
  });

  it("never shadows without an enabled marketplace twin", () => {
    expect(
      marketplaceTwinOwner(
        { name: "browser-automation", source: "bundled" },
        enabled,
      ),
    ).toBeUndefined();
    expect(
      marketplaceTwinOwner(
        { name: "zeroday-hunter", source: "zeroday-hunter@builtin" },
        new Set<string>(),
      ),
    ).toBeUndefined();
    expect(
      marketplaceTwinOwner(
        { name: "flash-board", source: "plugin" },
        enabled,
      ),
    ).toBeUndefined();
    expect(
      marketplaceTwinOwner({ name: "verify", source: undefined }, enabled),
    ).toBeUndefined();
  });
});
