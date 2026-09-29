import { readFile } from "node:fs/promises";
import { evaluateChildProviderSelector } from "../src/agents/provider-selector-evaluation.js";
import type { ChildSelectorEvaluationFixture } from "../src/agents/provider-selector-evaluation.js";

function bundledDataset(name: string): URL {
  switch (name) {
    case "synthetic":
      return new URL("../eval/provider-selector-policy/fixtures.json", import.meta.url);
    case "deepseek-2026-09-29":
      return new URL("../eval/provider-selector-live/measurements-2026-09-29/recorded-measurements.json", import.meta.url);
    default:
      throw new Error("Choose a bundled dataset: synthetic or deepseek-2026-09-29.");
  }
}

if (process.argv.length > 3) throw new Error("Choose a bundled dataset: synthetic or deepseek-2026-09-29.");
const fixture = JSON.parse(await readFile(bundledDataset(process.argv[2] ?? "synthetic"), "utf8")) as ChildSelectorEvaluationFixture;
process.stdout.write(`${JSON.stringify(evaluateChildProviderSelector(fixture), null, 2)}\n`);
