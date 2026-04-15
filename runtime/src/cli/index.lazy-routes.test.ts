import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  matchedRouteLoad,
  fallbackRouteLoad,
  matchedRouteRun,
  fallbackRouteRun,
} = vi.hoisted(() => ({
  matchedRouteLoad: vi.fn(),
  fallbackRouteLoad: vi.fn(),
  matchedRouteRun: vi.fn(async () => 0),
  fallbackRouteRun: vi.fn(async () => 0),
}));

vi.mock("./routes.js", () => ({
  CLI_ROUTES: [
    {
      name: "matched",
      matches: (parsed: { positional: string[] }) => parsed.positional[0] === "matched",
      load: matchedRouteLoad,
    },
    {
      name: "fallback",
      matches: () => true,
      load: fallbackRouteLoad,
    },
  ],
}));

import { runCli } from "./index.js";

function createSink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("runCli lazy route loading", () => {
  afterEach(() => {
    matchedRouteLoad.mockReset();
    fallbackRouteLoad.mockReset();
    matchedRouteRun.mockClear();
    fallbackRouteRun.mockClear();
  });

  it("does not load any route module for root help", async () => {
    const stdout = createSink();
    const stderr = createSink();

    await runCli({ argv: ["--help"], stdout, stderr });

    expect(matchedRouteLoad).not.toHaveBeenCalled();
    expect(fallbackRouteLoad).not.toHaveBeenCalled();
  });

  it("loads only the matched route family", async () => {
    matchedRouteLoad.mockResolvedValue({ run: matchedRouteRun });
    fallbackRouteLoad.mockResolvedValue({ run: fallbackRouteRun });

    const stdout = createSink();
    const stderr = createSink();

    await runCli({ argv: ["matched"], stdout, stderr });

    expect(matchedRouteLoad).toHaveBeenCalledTimes(1);
    expect(matchedRouteRun).toHaveBeenCalledTimes(1);
    expect(fallbackRouteLoad).not.toHaveBeenCalled();
    expect(fallbackRouteRun).not.toHaveBeenCalled();
  });
});
