import { describe, expect, test } from "vitest";

import { shellRestrictionParts } from "../../src/permissions/shell-restrictions.js";

describe("shellRestrictionParts", () => {
  test("splits pipelines without treating them as opaque", () => {
    expect(shellRestrictionParts("git status && npm test")).toEqual({
      commands: ["git status", "npm test"],
      opaque: false,
    });
    expect(shellRestrictionParts("rg foo | head")).toEqual({
      commands: ["rg foo", "head"],
      opaque: false,
    });
  });

  test("unwraps a shell -c body and refuses a script-file shell", () => {
    expect(shellRestrictionParts("bash -lc 'git push'")).toEqual({
      commands: ["git push"],
      opaque: false,
    });
    expect(shellRestrictionParts("bash script.sh")).toEqual({
      commands: [],
      opaque: true,
    });
  });

  test("strips safe env assignments and refuses unsafe ones", () => {
    expect(shellRestrictionParts("LANG=C rg foo")).toEqual({
      commands: ["rg foo"],
      opaque: false,
    });
    expect(shellRestrictionParts("LD_PRELOAD=x rg foo")).toEqual({
      commands: [],
      opaque: true,
    });
    expect(shellRestrictionParts("PATH=/usr/bin rg foo")).toEqual({
      commands: [],
      opaque: true,
    });
  });

  test("peels known launchers and keeps xargs, interpreters, and ssh opaque", () => {
    expect(shellRestrictionParts("sudo -n rg foo")).toEqual({
      commands: ["rg foo"],
      opaque: false,
    });
    expect(shellRestrictionParts("timeout 5 node server.js")).toEqual({
      commands: ["node server.js"],
      opaque: false,
    });
    expect(shellRestrictionParts("env LANG=C rg foo")).toEqual({
      commands: ["rg foo"],
      opaque: false,
    });
    expect(shellRestrictionParts("xargs rg foo")).toEqual({
      commands: ["rg foo"],
      opaque: true,
    });
    expect(shellRestrictionParts("python -c 'print(1)'")).toEqual({
      commands: [],
      opaque: true,
    });
    expect(shellRestrictionParts("ssh host rg foo")).toEqual({
      commands: [],
      opaque: true,
    });
    expect(shellRestrictionParts("timeout foo node")).toEqual({
      commands: [],
      opaque: true,
    });
  });

  test("normalizes a simple executable and fails closed on empty text", () => {
    expect(shellRestrictionParts("rg pattern")).toEqual({
      commands: ["rg pattern"],
      opaque: false,
    });
    expect(shellRestrictionParts("")).toEqual({
      commands: [],
      opaque: true,
    });
  });
});
