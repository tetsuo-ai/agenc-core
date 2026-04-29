import { describe, expect, it } from "vitest";
import { renderInstructionTemplate } from "./instruction-template.js";

describe("renderInstructionTemplate", () => {
  it("substitutes single placeholders", () => {
    const out = renderInstructionTemplate("Hello {name}!", { name: "World" });
    expect(out).toBe("Hello World!");
  });

  it("substitutes multiple placeholders", () => {
    const out = renderInstructionTemplate("{a} and {b}", { a: "x", b: "y" });
    expect(out).toBe("x and y");
  });

  it("leaves unknown placeholders verbatim (matches codex)", () => {
    const out = renderInstructionTemplate("Hi {missing}", { name: "x" });
    expect(out).toBe("Hi {missing}");
  });

  it("handles `{{` and `}}` as literal-brace escapes", () => {
    const out = renderInstructionTemplate("{{not a placeholder}}", {
      placeholder: "x",
    });
    expect(out).toBe("{not a placeholder}");
  });

  it("does not recurse into substituted values", () => {
    const out = renderInstructionTemplate("{a}", { a: "{b}", b: "deep" });
    expect(out).toBe("{b}");
  });
});
