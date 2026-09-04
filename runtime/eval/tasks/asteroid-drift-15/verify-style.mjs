import { checkStyle, jsFiles, fail, ok } from "./checks.mjs";
const files = jsFiles();
if (files.length === 0) fail("no JavaScript files in the workspace");
const problems = checkStyle();
const shown = problems.slice(0, 25).join("\n  ");
const more = problems.length > 25 ? `\n  ... ${problems.length - 25} more` : "";
if (problems.length > 0) fail(`style rules from prompt 1 violated:\n  ${shown}${more}`);
ok(`style rules hold across ${files.length} JavaScript files`);
