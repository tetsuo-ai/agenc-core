import { checkStyle, jsFiles, fail, ok } from "./checks.mjs";
const files = jsFiles();
if (files.length === 0) fail("no JavaScript files in the workspace");
const problems = checkStyle();
if (problems.length > 0) fail(`style rules from prompt 1 violated:\n  ${problems.slice(0, 25).join("\n  ")}${problems.length > 25 ? `\n  ... ${problems.length - 25} more` : ""}`);
ok(`style rules hold across ${files.length} JavaScript files`);
