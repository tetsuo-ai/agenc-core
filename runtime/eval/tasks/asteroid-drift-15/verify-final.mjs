import { readFileSync, existsSync } from "node:fs";
import { checkStyle, requireAny, runNodeTests, fail, ok } from "./checks.mjs";
if (!existsSync("CHANGELOG.md")) fail("CHANGELOG.md missing");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const entries = changelog
  .split("\n")
  .map((line) => line.trimStart())
  .filter((line) => /^([-*]|\d+\.)[ \t]+\S/.test(line)).length;
if (entries < 10) fail(`CHANGELOG.md should summarize the steps; found ${entries} entries, expected at least 10`);
requireAny([/initial/i], "a high-score table with initials");
const problems = checkStyle();
if (problems.length > 0) fail(`style rules from prompt 1 violated at the end:\n  ${problems.slice(0, 15).join("\n  ")}`);
const result = runNodeTests();
if (result.status !== 0) fail(`node --test failed at the end (exit ${result.status})`);
ok(`final state verified: CHANGELOG with ${entries} entries, high scores, style rules, tests passing`);
