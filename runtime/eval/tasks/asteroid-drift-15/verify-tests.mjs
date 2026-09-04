import { runNodeTests, jsFiles, fail, ok } from "./checks.mjs";
const testFiles = jsFiles().filter((f) => /(?:(?:^|\/)tests?\/)|(?:\.test\.m?js$)/.test(f));
if (testFiles.length === 0) fail("no test files found (test/ or *.test.js)");
const result = runNodeTests();
if (result.status !== 0) fail(`node --test failed (exit ${result.status}):\n${(result.stderr || result.stdout || "").slice(-2000)}`);
const passMatch = /^# pass (\d+)/m.exec(result.stdout || "");
if (!passMatch || Number(passMatch[1]) < 3) fail(`expected at least 3 passing tests, got: ${passMatch ? passMatch[1] : "no summary"}`);
ok(`node --test passed ${passMatch[1]} tests across ${testFiles.length} files`);
