import React from "react";
import { describe, expect, test } from "vitest";
import { renderToString } from "../../utils/staticRender.js";
import { LiveRunLine } from "../../../src/tui/components/LiveRunLine.js";
import type { TurnEfficiency } from "../../../src/tui/turn-efficiency.js";

const turn: TurnEfficiency = {
  modelCalls: 47,
  lastRequest: { inputTokens: 128_000, cachedInputTokens: 124_160, outputTokens: 2_100 },
  usage: { inputTokens: 1_200_000, cachedInputTokens: 1_164_000, outputTokens: 8_400 },
};

describe("LiveRunLine", () => {
  test("uses the last completed request and shows how full the context is", async () => {
    const output = await renderToString(<LiveRunLine turn={turn} />, { columns: 80, rows: 24 });
    expect(output.trim()).toBe("47 calls · input 128K · cached 97%");
  });

  test("shows calls before usage arrives and omits unavailable context", async () => {
    const output = await renderToString(<LiveRunLine turn={{ modelCalls: 1, lastRequest: null, usage: null }} />);
    expect(output.trim()).toBe("1 call");
  });

  test("omits unknown cache shares", async () => {
    const output = await renderToString(<LiveRunLine turn={{ ...turn,
      lastRequest: { inputTokens: 128_000, outputTokens: 2_100, cachedInputTokens: null },
    }} />);
    expect(output.trim()).toBe("47 calls · input 128K");
  });

  test("does not label nearly complete cache reuse as fully cached", async () => {
    const output = await renderToString(<LiveRunLine turn={{ ...turn,
      lastRequest: { inputTokens: 1_000_000, outputTokens: 100, cachedInputTokens: 999_999 },
    }} />);
    expect(output.trim()).toBe("47 calls · input 1M · cached 99%");
  });

  test.each([80, 58, 40, 25, 12, 4])("fits complete fields in one line at %s columns", async columns => {
    const output = await renderToString(<LiveRunLine turn={turn} />, { columns, rows: 24 });
    const text = output.trim();
    expect(text.split("\n")).toHaveLength(1);
    expect(text.length).toBeLessThanOrEqual(columns - 2);
    if (columns === 40) expect(text).toBe("47 calls · input 128K · cached 97%");
    if (columns === 25) expect(text).toBe("47 calls · input 128K");
  });
});
