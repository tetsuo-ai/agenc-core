import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../utils/logger.js";

import { runMarketTuiCommand, shouldUseInteractiveMarketplace } from "./marketplace-tui.js";

function createTtyInput(lines: string[]): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  queueMicrotask(() => {
    for (const line of lines) {
      stream.write(`${line}\n`);
    }
    stream.end();
  });
  return stream;
}

function createTtyOutput(): {
  stream: PassThrough & { isTTY: boolean; columns: number };
  getText: () => string;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  stream.isTTY = true;
  stream.columns = 100;
  stream.on("data", (chunk) => {
    chunks.push(String(chunk));
  });
  return {
    stream,
    getText: () => chunks.join(""),
  };
}

describe("marketplace TUI", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires tty output and non-json formatting", () => {
    expect(
      shouldUseInteractiveMarketplace(
        { "output-format": "table" },
        {
          stdin: { isTTY: true },
          stdout: { isTTY: true },
        } as never,
      ),
    ).toBe(true);
    expect(
      shouldUseInteractiveMarketplace(
        { "output-format": "json" },
        {
          stdin: { isTTY: true },
          stdout: { isTTY: true },
        } as never,
      ),
    ).toBe(false);
  });

  it("opens and closes from the main menu", async () => {
    const input = createTtyInput(["q"]);
    const stdout = createTtyOutput();
    const error = vi.fn();

    const code = await runMarketTuiCommand(
      {
        logger: silentLogger,
        output: vi.fn(),
        error,
        outputFormat: "table",
      },
      {
        help: false,
        outputFormat: "table",
        strictMode: false,
        storeType: "sqlite",
        idempotencyWindow: 900,
      },
      {
        stdin: input,
        stdout: stdout.stream,
      },
    );

    input.destroy();
    stdout.stream.destroy();

    expect(code).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(stdout.getText()).toContain("MARKETPLACE TERMINAL > workspace");
    expect(stdout.getText()).toContain("Marketplace terminal closed.");
  });
});
