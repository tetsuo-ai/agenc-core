import { describe, expect, test } from "vitest";

import { createLSPClient } from "./LSPClient.js";

const EXITING_SERVER = "setTimeout(() => process.exit(1), 10)";

describe("createLSPClient", () => {
  test("clears closed process state so a crashed server can be started again", async () => {
    let crashCount = 0;
    const client = createLSPClient("crashy", {
      onCrash: () => {
        crashCount += 1;
      },
    });

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(1);

    await client.start(process.execPath, ["-e", EXITING_SERVER]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(crashCount).toBe(2);
  });
});
