import React from "react";
import { describe, expect, it } from "vitest";

import { TestSurfaceView } from "../../../src/tui/workbench/surfaces/TestSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("TestSurfaceView", () => {
  it("clamps stale selection to the last parsed failure", async () => {
    const output = await renderToString(
      <TestSurfaceView
        failures={[
          {
            id: "first",
            name: "first failure",
            location: { file: "src/first.ts", line: 4 },
            message: "first message",
          },
          {
            id: "second",
            name: "second failure",
            location: { file: "src/second.ts", line: 9 },
            message: "second message",
          },
        ]}
        selected={99}
        focused={true}
      />,
      80,
    );

    expect(output).toContain("second failure");
    expect(output).toContain("second message");
  });
});
