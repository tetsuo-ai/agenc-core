import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { isBareMode } from "../../src/utils/envUtils.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";

describe("typed simple mode", () => {
  test("reads simple mode only from the session ingress binding", () => {
    expect(isBareMode()).toBe(false);
    expect(
      runWithAgentRuntimeOptions(
        resolveAgentRuntimeOptions({}, { simpleMode: true }),
        () => isBareMode(),
      ),
    ).toBe(true);
  });

  test.each(["AGENC_SIMPLE", "AGENC_BARE"] as const)(
    "rejects removed %s environment input even when empty",
    (key) => {
      expect(() => resolveAgentRuntimeOptions({ [key]: "" })).toThrow(
        `${key} was removed; use --bare`,
      );
    },
  );

  test("does not project --bare through a process environment alias", () => {
    const mainSource = readFileSync(
      new URL("../../src/bin/agenc-main.ts", import.meta.url),
      "utf8",
    );
    const envUtilsSource = readFileSync(
      new URL("../../src/utils/envUtils.ts", import.meta.url),
      "utf8",
    );
    const runtimeOptionsSource = readFileSync(
      new URL("../../src/session/runtime-options.ts", import.meta.url),
      "utf8",
    );

    expect(mainSource).not.toContain("withSimpleModeEnv");
    expect(mainSource).not.toContain("AGENC_SIMPLE");
    expect(envUtilsSource).not.toContain("AGENC_SIMPLE");
    expect(runtimeOptionsSource).not.toContain(
      'parseBoolean(env, "AGENC_SIMPLE"',
    );
  });

  test("keeps authentication outside bare-mode policy", () => {
    const credentialSources = [
      "../../src/utils/auth.ts",
      "../../src/utils/githubModelsCredentials.ts",
      "../../src/utils/xaiOauthCredentials.ts",
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");

    expect(credentialSources).not.toContain("isBareMode");
  });
});
