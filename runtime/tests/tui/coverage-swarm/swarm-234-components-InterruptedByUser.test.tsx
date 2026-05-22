import React, { useLayoutEffect, useState } from "react";
import { describe, expect, test } from "vitest";

import { InterruptedByUser } from "../../../src/tui/components/InterruptedByUser.js";
import { renderToString } from "../../../src/utils/staticRender.js";

function RerenderInterruptedByUser() {
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    if (count === 0) setCount(1);
  }, [count]);

  return <InterruptedByUser />;
}

describe("InterruptedByUser coverage swarm row 234", () => {
  test("renders the interruption prompt and not the disabled issue hint", async () => {
    const output = await renderToString(<InterruptedByUser />, { columns: 80 });

    expect(output).toContain("Interrupted");
    expect(output).toContain("What should AgenC do instead?");
    expect(output).not.toContain("/issue");
    expect(output).not.toContain("model issue");
  });

  test("keeps the memoized prompt stable across rerenders", async () => {
    const output = await renderToString(<RerenderInterruptedByUser />, {
      columns: 80,
    });

    expect(output).toContain("Interrupted");
    expect(output).toContain("What should AgenC do instead?");
  });
});
