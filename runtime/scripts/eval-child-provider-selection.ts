import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateChildProviderSelector } from "../src/agents/provider-selector-evaluation.js";
import type { ChildSelectorEvaluationFixture } from "../src/agents/provider-selector-evaluation.js";

const fixturePath = process.argv[2] ?? fileURLToPath(new URL("../eval/provider-selector-policy/fixtures.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ChildSelectorEvaluationFixture;
process.stdout.write(`${JSON.stringify(evaluateChildProviderSelector(fixture), null, 2)}\n`);
