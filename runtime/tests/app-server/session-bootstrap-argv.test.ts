import { describe, expect, test } from "vitest";

import { buildStructuredSessionBootstrapArgv } from "../../src/app-server/session-bootstrap-argv.js";
import { MAX_ADDITIONAL_WORKING_DIRECTORIES } from "../../src/contracts/additional-working-directories.js";

const EXECUTABLE = "node";
const ENTRYPOINT = "/opt/agenc/dist/agenc.js";

describe("buildStructuredSessionBootstrapArgv", () => {
  test.each([
    { name: "missing both", argv: [] as const },
    { name: "missing entrypoint", argv: ["node"] as const },
    { name: "blank executable", argv: ["", ENTRYPOINT] as const },
    { name: "whitespace entrypoint", argv: [EXECUTABLE, "  "] as const },
  ])("rejects $name", ({ argv }) => {
    expect(() =>
      buildStructuredSessionBootstrapArgv({ permissionMode: "plan" }, argv),
    ).toThrow(TypeError);
  });

  test("inherits only the executable and entrypoint from process argv", () => {
    const argv = buildStructuredSessionBootstrapArgv(
      {
        provider: "grok",
        model: "grok-4.6",
        profile: "fast",
        configPath: "/workspace/explicit-config.toml",
        permissionMode: "plan",
        addDirs: ["../shared workspace", "/tmp/shared"],
      },
      [
        EXECUTABLE,
        ENTRYPOINT,
        "--provider",
        "openai",
        "--model",
        "daemon-default",
        "--yolo",
        "daemon",
        "run",
      ],
    );

    expect(argv).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--provider",
      "grok",
      "--model",
      "grok-4.6",
      "--profile",
      "fast",
      "--config",
      "/workspace/explicit-config.toml",
      "--add-dir=../shared workspace",
      "--add-dir=/tmp/shared",
      "--permission-mode",
      "plan",
    ]);
  });

  test("omits blank optional flags and still pins permission mode", () => {
    expect(
      buildStructuredSessionBootstrapArgv(
        {
          provider: "  ",
          model: "",
          profile: undefined,
          permissionMode: "bypassPermissions",
        },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("deduplicates addDirs in first-seen order and rejects empty or overflowing paths", () => {
    expect(
      buildStructuredSessionBootstrapArgv(
        { addDirs: ["/tmp/a", "/tmp/b", "/tmp/a"] },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--add-dir=/tmp/a",
      "--add-dir=/tmp/b",
    ]);

    expect(() =>
      buildStructuredSessionBootstrapArgv(
        { addDirs: [""] },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toThrow(/must not contain an empty path/u);

    expect(() =>
      buildStructuredSessionBootstrapArgv(
        {
          addDirs: Array.from(
            { length: MAX_ADDITIONAL_WORKING_DIRECTORIES + 1 },
            (_, index) => `/tmp/shared-${index}`,
          ),
        },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toThrow(
      `session bootstrap addDirs accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
    );
  });
});
