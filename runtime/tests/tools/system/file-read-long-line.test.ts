import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, test } from "vitest";

// Run the production reader in a small heap. Importing the entire runtime into
// that heap would test module loading instead of the reader's memory bound.
// This is the independent review's 64 MiB line / 32 MiB heap reproduction,
// extended to the descriptor-bound reader and lines on either side of a range.
let root: string;
let input: string;
const workers = new Map<string, string>();
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "read-long-line-"));
  input = join(root, "large.txt");
  const fd = openSync(input, "w");
  try {
    writeSync(fd, "requested first line\n");
    const chunk = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 64; i += 1) writeSync(fd, chunk);
    writeSync(fd, "\nlast\n");
  } finally { closeSync(fd); }

  const path = new URL("../../../src/tools/system/file-read.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
  const declarations = ["sliceTextFileByLineStream", "formatBytes"].map(name => {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!fn) throw new Error(`Missing production function: ${name}`);
    return fn.getText(ast);
  }).join("\n");
  const reader = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  workers.set("file", [
    'import { createReadStream } from "node:fs";',
    'import { createInterface } from "node:readline";',
    "const DEFAULT_LINE_LIMIT = 2000;",
    reader,
    "try {",
    "const result = await sliceTextFileByLineStream(process.argv[2], Number(process.argv[3]), Number(process.argv[4]), 256 * 1024, true);",
    "console.log(JSON.stringify(result));",
    "} catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }",
  ].join("\n"));

  const bound = readFileSync(new URL("../../../src/workspace/file-mutation-transaction.ts", import.meta.url), "utf8");
  const marker = '} else if (command.operation === "read_text_window") {';
  const start = bound.indexOf(marker);
  const end = bound.indexOf('} else if (command.operation === "run_pinned_rg") {', start);
  if (start < 0 || end < 0) throw new Error("Missing production bound text reader");
  workers.set("bound", [
    'import { open } from "node:fs/promises";',
    'import { createInterface } from "node:readline";',
    "const handle = await open(process.argv[2], 'r');",
    "const opened = { handle, stats: await handle.stat({ bigint: true }) };",
    "const command = { offset: Number(process.argv[3]), limit: Number(process.argv[4]), maxBytes: 256 * 1024, completeLineCount: true };",
    "const stats = {};",
    "const send = result => console.log(JSON.stringify({ ...result, content: Buffer.from(result.contentBase64 ?? '', 'base64').toString('utf8') }));",
    "try {",
    bound.slice(start + marker.length, end),
    "} catch (error) { send({ code: error.code, message: error.message }); } finally { await handle.close(); }",
  ].join("\n"));
  for (const [name, code] of workers) writeFileSync(join(root, `${name}.mjs`), code);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

for (const reader of ["file", "bound"]) {
  test.each([
    { offset: 1, limit: 1, content: "requested first line", numLines: 1 },
    { offset: 3, limit: 1, content: "last", numLines: 1 },
    { offset: 1, limit: 100, content: "requested first line", numLines: 1 },
    { offset: 2, limit: 1, code: "FILE_TOO_LARGE" },
  ])(`${reader}: a short window stays bounded around a long unreturned line ($offset, $limit)`, expected => {
    const result = spawnSync(process.execPath, [
      "--max-old-space-size=32", join(root, `${reader}.mjs`), input,
      String(expected.offset), String(expected.limit),
    ], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024,
      env: { NODE_OPTIONS: "", NODE_PATH: "" },
    });
    expect({ error: result.error?.message, status: result.status, signal: result.signal }, result.stderr)
      .toEqual({ error: undefined, status: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject("code" in expected
      ? { code: expected.code }
      : { content: expected.content, numLines: expected.numLines,
        startLine: expected.offset, endLine: expected.offset, totalLines: 4 });
  });
}
