import { describe, expect, test } from "vitest";

import { clearAllPluginCaches } from "../../../src/utils/plugins/cacheUtils.js";

describe("plugin cache utilities", () => {
  test("clears active plugin caches without legacy loader modules", () => {
    expect(() => clearAllPluginCaches()).not.toThrow();
  });
});
