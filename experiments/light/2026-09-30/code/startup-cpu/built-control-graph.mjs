import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const core = resolve(process.argv[2]);
const require = createRequire(resolve(core, 'package.json'));
const ts = require('typescript');
const entry = resolve(core, 'runtime/dist/bin/agenc-main.js');
const seen = new Set();
const sources = new Set();
const files = {};
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const data = readFileSync(file);
  files[relative(core, file)] = createHash('sha256').update(data).digest('hex');
  const ast = ts.createSourceFile(file, data.toString('utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const module = statement.moduleSpecifier;
    if (module && ts.isStringLiteral(module) && module.text.startsWith('.')) {
      visit(resolve(dirname(file), module.text));
    }
  }
  if (existsSync(file + '.map')) {
    const map = JSON.parse(readFileSync(file + '.map', 'utf8'));
    for (const source of map.sources ?? []) sources.add(source);
  }
}
visit(entry);
const forbidden = [...sources].filter(source => /\/app-server\/daemon-cli\.ts$/.test(source));
console.log(JSON.stringify({ entry: relative(core, entry), static_files: seen.size,
  mapped_sources: sources.size, foreground_sources: forbidden,
  control_sources: [...sources].filter(source => /\/app-server\/daemon-control\.ts$/.test(source)),
  file_sha256: files }, null, 2));
if (forbidden.length) process.exitCode = 1;
