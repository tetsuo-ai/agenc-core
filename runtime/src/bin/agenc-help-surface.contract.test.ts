import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("agenc top-level help surface", () => {
  it("advertises daemon reload in top-level daemon usage", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "agenc.ts"),
      "utf8",
    );

    expect(source).toContain(
      '"       agenc daemon <stop|status|reload|restart>",',
    );
  });
});
