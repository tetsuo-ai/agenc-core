import { expect, test, vi } from "vitest";
import { estimateUtf8TokenUnits } from "../../src/llm/token-accounting.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";

test("fast estimates preserve every UTF-16 code unit and normalization expansion", () => {
  const values = ["", "ASCII prompt\n".repeat(1000), "\u0000\t\r\n\u007f", "é", "e\u0301", "ﷺ", "👩‍💻", "𐀀", "\ud800x\udfff"];
  for (let start = 0; start < 65_536; start += 256) {
    values.push(String.fromCharCode(...Array.from({ length: 256 }, (_, n) => start + n)));
  }
  for (const value of values) {
    for (const divisor of [1, 4, 3.7, 0, Infinity, NaN]) {
      const expected = estimateUtf8TokenUnits(value, divisor);
      expect(withOneShotFastMode(() => estimateUtf8TokenUnits(value, divisor))).toBe(expected);
    }
  }
});

test("fast ASCII estimation does not allocate encoded prompt copies", () => {
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    expect(withOneShotFastMode(() => estimateUtf8TokenUnits("ASCII prompt", 4))).toBe(3);
    expect(encode).not.toHaveBeenCalled();
  } finally { encode.mockRestore(); }
});
