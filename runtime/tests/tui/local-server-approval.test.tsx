import React from "react";
import { expect, test } from "vitest";
import { ApprovalCard } from "../../src/tui/components/v2/primitives.js";
import { renderToString } from "../../src/utils/staticRender.js";

test("server approval keeps the reason visible beyond the first terminal line", async () => {
  const output = await renderToString(<ApprovalCard risk="low" title="Run"
    command="python3 -m http.server 8000 --bind 127.0.0.1" facts={[]}
    confirmLabel="enter" note={"Allow the local preview server so you can open your new page in a browser? This command runs outside the sandbox; the earlier approval only allowed the command to run with sandbox limits."}
  />, { columns: 120, rows: 40 });
  expect(output).toContain("Allow the local preview server");
  expect(output).toContain("sandbox limits.");
  expect(output).toContain("approve once");
  expect(output).toContain("deny");
});
