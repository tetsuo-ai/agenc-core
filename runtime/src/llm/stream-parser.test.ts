import { describe, expect, test } from "vitest";
import {
  CitationStreamParser,
  ProposedPlanStreamParser,
  extractProposedPlanText,
  stripCitations,
  stripProposedPlanBlocks,
} from "./stream-parser.js";

describe("stream-parser", () => {
  test("stripCitations removes inline citation tags", () => {
    const { visibleText, citations } = stripCitations(
      "a<oai-mem-citation>one</oai-mem-citation>b<oai-mem-citation>two</oai-mem-citation>c",
    );
    expect(visibleText).toBe("abc");
    expect([...citations]).toEqual(["one", "two"]);
  });

  test("stripCitations auto-closes unterminated tag at EOF", () => {
    const { visibleText, citations } = stripCitations("x<oai-mem-citation>y");
    expect(visibleText).toBe("x");
    expect([...citations]).toEqual(["y"]);
  });

  test("stripProposedPlanBlocks removes plan blocks", () => {
    const text = "pre<proposed_plan>inner</proposed_plan>post";
    expect(stripProposedPlanBlocks(text)).toBe("prepost");
    expect([...extractProposedPlanText(text)]).toEqual(["inner"]);
  });

  test("CitationStreamParser handles tag split across chunks", () => {
    const parser = new CitationStreamParser();
    const a = parser.pushStr("Hello <oai-mem-");
    const b = parser.pushStr("citation>source A</oai-mem-");
    const c = parser.pushStr("citation> world");
    const tail = parser.finish();
    const visible =
      a.visibleText + b.visibleText + c.visibleText + tail.visibleText;
    const extracted = [...a.extracted, ...b.extracted, ...c.extracted, ...tail.extracted];
    expect(visible).toBe("Hello  world");
    expect(extracted.map((e) => e.content)).toEqual(["source A"]);
  });

  test("ProposedPlanStreamParser emits extracted plan content across chunks", () => {
    const parser = new ProposedPlanStreamParser();
    const a = parser.pushStr("head<proposed_plan>step ");
    const b = parser.pushStr("one</proposed_plan>tail");
    const tail = parser.finish();
    const visible = a.visibleText + b.visibleText + tail.visibleText;
    expect(visible).toBe("headtail");
    const extracted = [...a.extracted, ...b.extracted].map((e) => e.content);
    expect(extracted).toEqual(["step one"]);
  });
});
