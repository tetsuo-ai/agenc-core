import React from "react";
import { describe, expect, test } from "vitest";

import { ShellTimeDisplay } from "../../../src/tui/components/shell/ShellTimeDisplay.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("ShellTimeDisplay coverage swarm row 151", () => {
  test("renders nothing when neither elapsed time nor timeout is available", async () => {
    const output = await renderToString(<ShellTimeDisplay />);

    expect(output.trim()).toBe("");
  });

  test("renders timeout-only state with trailing zero units hidden", async () => {
    const output = await renderToString(
      <ShellTimeDisplay timeoutMs={120_000} />,
    );

    expect(output).toBe("(timeout 2m)");
  });

  test("renders elapsed time without timeout metadata", async () => {
    const output = await renderToString(
      <ShellTimeDisplay elapsedTimeSeconds={65} timeoutMs={undefined} />,
    );

    expect(output).toBe("(1m 5s)");
  });

  test("renders elapsed time and timeout metadata together", async () => {
    const output = await renderToString(
      <ShellTimeDisplay elapsedTimeSeconds={65} timeoutMs={120_000} />,
    );

    expect(output).toContain("(1m 5s");
    expect(output).toContain("timeout 2m)");
  });
});
