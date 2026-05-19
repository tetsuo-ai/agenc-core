import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourcePath } from "../helpers/source-path.ts";

describe("agenc top-level help surface", () => {
  it("advertises daemon reload in top-level daemon usage", () => {
    const source = readFileSync(sourcePath("bin/agenc.ts"), "utf8");

    expect(source).toContain(
      '"       agenc daemon <stop|status|reload|restart>",',
    );
  });
});
