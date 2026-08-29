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
    expect(source).toContain(
      '"       agenc run <start|status|result|replay|evidence|cancel> [<run-id>] [options]",',
    );
    expect(source).toContain(
      '"       agenc doctor [--json | --apparmor-profile]",',
    );
    expect(source).toContain('"       agenc remote <on|status|off>",');
    expect(source).toContain(
      '"  run                                     Start, inspect, replay, export, or cancel a durable run",',
    );
    expect(source).toContain(
      '"  doctor                                  Diagnose installation and runtime readiness",',
    );
    expect(source).toContain(
      '"  remote                                  Manage phone remote-control pairing",',
    );
    expect(source).toContain('"       agenc plugin <command> [options]",');
    expect(source).toContain('"       agenc permissions <command>",');
    expect(source).toContain(
      '"  -p, --print                             Run in headless one-shot print mode",',
    );
    expect(source).toContain(
      '"  --autonomous                             Enable autonomous tick mode",',
    );
  });
});
