import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourcePath } from "../helpers/source-path.ts";

describe("agenc top-level help surface", () => {
  it("advertises the real routed command surface", () => {
    const source = readFileSync(sourcePath("bin/agenc-main.ts"), "utf8");

    expect(source).toContain(
      '"       agenc daemon <stop|status|reload|restart>",',
    );
    expect(source).toContain(
      '"       agenc providers [--json] [--no-local-check]",',
    );
    expect(source).toContain('"       agenc plugin <command> [options]",');
    expect(source).toContain('"       agenc permissions <command>",');
    expect(source).toContain(
      '"  -p, --print                             Run in headless one-shot print mode",',
    );
    expect(source).toContain(
      '"  --autonomous, --proactive                Enable autonomous tick mode",',
    );
  });
});
