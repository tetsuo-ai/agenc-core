import { describe, expect, it } from "vitest";

import { isDisplayStructuralValue } from "../../src/mcp-client/display-attachments.js";

describe("isDisplayStructuralValue", () => {
  it("accepts the four chart kinds at the kind path", () => {
    for (const kind of ["timeseries", "category", "xy", "pie"]) {
      expect(isDisplayStructuralValue(["kind"], kind, undefined)).toBe(true);
    }
    expect(isDisplayStructuralValue(["kind"], "table", undefined)).toBe(false);
    expect(isDisplayStructuralValue(["title"], "timeseries", undefined)).toBe(
      false,
    );
  });

  it("only treats currency and series fields as structure on a timeseries chart", () => {
    expect(isDisplayStructuralValue(["currency"], "USD", "timeseries")).toBe(
      true,
    );
    expect(isDisplayStructuralValue(["currency"], "usd", "timeseries")).toBe(
      false,
    );
    expect(isDisplayStructuralValue(["currency"], "USD", "category")).toBe(
      false,
    );
    expect(isDisplayStructuralValue(["currency"], "XXX", "timeseries")).toBe(
      true,
    );
    expect(isDisplayStructuralValue(["currency"], "ZZZ", "timeseries")).toBe(
      false,
    );
  });

  it("accepts timeseries series type and scale at the wildcard path", () => {
    expect(
      isDisplayStructuralValue(["series", "*", "type"], "line", "timeseries"),
    ).toBe(true);
    expect(
      isDisplayStructuralValue(
        ["series", "*", "type"],
        "candlestick",
        "timeseries",
      ),
    ).toBe(true);
    expect(
      isDisplayStructuralValue(["series", "*", "scale"], "volume", "timeseries"),
    ).toBe(true);
    expect(
      isDisplayStructuralValue(["series", "*", "type"], "scatter", "timeseries"),
    ).toBe(false);
    expect(
      isDisplayStructuralValue(["series", "0", "type"], "line", "timeseries"),
    ).toBe(false);
  });
});
