import { describe, expect, it } from "vitest";

import {
  buildSkillListingWithinBudget,
  rankSkillsForRequest,
  type SkillListingEntry,
} from "./local-loader.js";

const skill = (name: string, description: string): SkillListingEntry => ({
  name,
  description,
  scope: "user",
  loadedFrom: "skills",
});

/** Fillers that sort before every skill the tests look for. */
const fillers = (count: number, word = "filler"): SkillListingEntry[] =>
  Array.from({ length: count }, (_, i) =>
    skill(`aa-${word}-${String(i).padStart(3, "0")}`, `An unrelated ${word} helper number ${i}`),
  );

describe("skill relevance", () => {
  it("matches a plural in the request to the singular in a skill name", () => {
    const catalog = [
      ...fillers(50),
      skill("jest-test-generator", "Jest Test Generator - Auto-activating skill for Test Automation."),
    ];
    const ranked = rankSkillsForRequest(catalog, "write tests for the parser", new Set(), 12);
    expect(ranked.names[0]).toBe("jest-test-generator");
  });

  it("weighs a word by how rare it is among the installed skills", () => {
    // "service" is in thirty skill names, "dockerfile" in one.
    const catalog = [
      ...fillers(30, "service"),
      skill("dockerfile-generator", "Dockerfile Generator - Auto-activating skill for DevOps Basics."),
    ];
    const ranked = rankSkillsForRequest(catalog, "write a dockerfile for this service", new Set(), 12);
    expect(ranked.names[0]).toBe("dockerfile-generator");
    const listing = buildSkillListingWithinBudget(catalog, 2_000, "write a dockerfile for this service");
    expect(listing.listedNames[0]).toBe("dockerfile-generator");
  });

  it("leaves out lines that only share a common word with the request", () => {
    const catalog = [
      ...Array.from({ length: 40 }, (_, i) =>
        skill(`vendor${i}-deploy-integration`, `Deploy vendor ${i} with its CLI`),
      ),
      skill("vercel-deploy", "Deploy a project to Vercel"),
    ];
    const ranked = rankSkillsForRequest(catalog, "deploy to vercel", new Set(), 12);
    expect(ranked.names).toEqual(["vercel-deploy"]);
  });

  it("still lists every close match up to the limit", () => {
    const catalog = [
      ...fillers(20),
      ...Array.from({ length: 15 }, (_, i) =>
        skill(`pdf-tool-${String(i).padStart(2, "0")}`, "Work with PDF documents"),
      ),
    ];
    const ranked = rankSkillsForRequest(catalog, "make a pdf report", new Set(), 12);
    expect(ranked.names).toHaveLength(12);
    expect(ranked.names.every((name) => name.startsWith("pdf-tool-"))).toBe(true);
  });

  it("ranks the same way on every call over the same catalog", () => {
    const catalog = [...fillers(100), skill("pdf", "Read and write PDF files")];
    const first = rankSkillsForRequest(catalog, "summarize this pdf", new Set(), 12);
    const second = rankSkillsForRequest(catalog, "summarize this pdf", new Set(), 12);
    expect(second).toEqual(first);
    expect(first.names[0]).toBe("pdf");
  });
});
