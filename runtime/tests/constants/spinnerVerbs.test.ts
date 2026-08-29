import { describe, expect, test } from "vitest";

import {
  getSpinnerVerbs,
  SPINNER_VERBS,
} from "../../src/constants/spinnerVerbs.js";

// #1: a frozen flavor verb that spells a genuine system/daemon/transport state
// reads as a fault — a slow turn once showed "Booting…" for 12 minutes and
// looked like the daemon was hung. The flavor list must never name such a
// state. This guard is revert-sensitive: re-adding any of these goes red.
const SYSTEM_STATE_COLLISIONS = [
  "Booting",
  "Daemonizing",
  "Mounting",
  "Buffering",
  "Compiling",
  "Linking",
  "Reconnecting",
  "Connecting",
  "Disconnected",
];

describe("SPINNER_VERBS flavor list", () => {
  test("contains no word that names a real system/daemon/transport state", () => {
    for (const collision of SYSTEM_STATE_COLLISIONS) {
      expect(SPINNER_VERBS).not.toContain(collision);
    }
  });

  test("is still a non-empty list of capitalized flavor verbs", () => {
    expect(SPINNER_VERBS.length).toBeGreaterThan(0);
    for (const verb of SPINNER_VERBS) {
      expect(verb).toMatch(/^[A-Z]/);
    }
  });
});

describe("getSpinnerVerbs", () => {
  test("returns an independent copy of the defaults when no config is set", () => {
    const resolved = getSpinnerVerbs(undefined);

    expect(resolved).toEqual(SPINNER_VERBS);
    expect(resolved).not.toBe(SPINNER_VERBS);
  });

  test("appends configured verbs after the defaults", () => {
    expect(
      getSpinnerVerbs({ mode: "append", verbs: ["Reticulating"] }),
    ).toEqual([...SPINNER_VERBS, "Reticulating"]);
  });

  test("replaces the defaults with configured verbs", () => {
    expect(
      getSpinnerVerbs({ mode: "replace", verbs: ["Reticulating"] }),
    ).toEqual(["Reticulating"]);
  });

  test("falls back to defaults when replace is configured with no verbs", () => {
    expect(getSpinnerVerbs({ mode: "replace", verbs: [] })).toEqual(
      SPINNER_VERBS,
    );
  });
});
