import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearAllOutputStylesCache,
  getAllOutputStyles,
  getOutputStyleConfig,
} from "../../src/constants/outputStyles.js";
import { loadPluginOutputStyles } from "../../src/plugins/registration/load-plugin-output-styles.js";
import { getOutputStyleDirStyles } from "../../src/outputStyles/loadOutputStylesDir.js";

vi.mock("../../src/outputStyles/loadOutputStylesDir.js", () => ({
  getOutputStyleDirStyles: vi.fn(),
}));

vi.mock("../../src/plugins/registration/load-plugin-output-styles.js", () => ({
  loadPluginOutputStyles: vi.fn(),
}));

describe("getAllOutputStyles", () => {
  afterEach(() => {
    clearAllOutputStylesCache();
    vi.mocked(getOutputStyleDirStyles).mockReset();
    vi.mocked(loadPluginOutputStyles).mockReset();
  });

  test("merges plugin styles from the registration loader", async () => {
    vi.mocked(getOutputStyleDirStyles).mockResolvedValue([]);
    vi.mocked(loadPluginOutputStyles).mockResolvedValue([
      {
        name: "sample:terse",
        description: "Short plugin replies",
        prompt: "Use short responses.",
        source: "plugin",
        plugin: "sample",
        filePath: "/plugin/output-styles/terse.md",
        forceForPlugin: true,
      },
    ]);

    const styles = await getAllOutputStyles("/workspace");

    expect(loadPluginOutputStyles).toHaveBeenCalledTimes(1);
    expect(styles["sample:terse"]).toMatchObject({
      name: "sample:terse",
      description: "Short plugin replies",
      prompt: "Use short responses.",
      source: "plugin",
      forceForPlugin: true,
    });
  });

  test("selects forced plugin styles from the registration loader", async () => {
    vi.mocked(getOutputStyleDirStyles).mockResolvedValue([]);
    vi.mocked(loadPluginOutputStyles).mockResolvedValue([
      {
        name: "sample:forced",
        description: "Forced plugin style",
        prompt: "Use plugin policy.",
        source: "plugin",
        plugin: "sample",
        filePath: "/plugin/output-styles/forced.md",
        forceForPlugin: true,
      },
    ]);

    await expect(getOutputStyleConfig()).resolves.toMatchObject({
      name: "sample:forced",
      source: "plugin",
      prompt: "Use plugin policy.",
      forceForPlugin: true,
    });
  });
});
