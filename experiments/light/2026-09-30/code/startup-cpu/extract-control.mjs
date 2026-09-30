// Mechanical declaration move; preserves declaration bodies for review.
import fs from 'node:fs';
import path from 'node:path';
import ts from '/private/tmp/light-takeover/startup-core/node_modules/typescript/lib/typescript.js';
const root = '/private/tmp/light-takeover/startup-core';
const file = path.join(root, 'runtime/src/app-server/daemon-cli.ts');
const original = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
const names = s => ts.isVariableStatement(s)
  ? s.declarationList.declarations.map(d => d.name.getText(sf))
  : s.name ? [s.name.text] : [];
const declarations = new Map();
for (const s of sf.statements) for (const name of names(s)) declarations.set(name, s);
const selected = new Set();
for (const s of sf.statements) {
  const line = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line+1;
  if ((line < 3062 || line >= 6784) && names(s).length &&
      s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) selected.add(s);
}
function dependencies(s) {
  const result = new Set();
  function walk(n) {
    if (ts.isIdentifier(n) && n.text !== 'runAgenCDaemonForeground') {
      const declaration = declarations.get(n.text);
      if (declaration) result.add(declaration);
    }
    ts.forEachChild(n, walk);
  }
  walk(s);
  return result;
}
for (const s of selected) for (const dep of dependencies(s)) selected.add(dep);
const selectedNames = [...selected].flatMap(names);
console.log(JSON.stringify({ moved: selectedNames, retained: sf.statements.filter(s => names(s).length && !selected.has(s)).flatMap(names) }, null, 2));
if (!process.argv.includes('--apply')) process.exit(0);
if (!original.includes('async function runAgenCDaemonForeground(')) throw new Error('Unexpected source');
const imports = sf.statements.filter(ts.isImportDeclaration).map(s => s.getText(sf)).join('\n');
const publicNames = [...selected].filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap(names);
const moved = sf.statements.filter(s => selected.has(s)).map(s => {
  const text = s.getFullText(sf);
  return s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ? text : text.slice(0, s.getStart(sf)-s.getFullStart())+'export '+s.getText(sf);
}).join('\n');
const control = `/** Canonical daemon lifecycle/control surface. Foreground runtime loads only on run. */\n${imports}\n${moved}\n\nasync function runAgenCDaemonForeground(...args: Parameters<typeof import("./daemon-cli.js").runAgenCDaemonForeground>): Promise<number> {\n  const runtime = await import("./daemon-cli.js");\n  return runtime.runAgenCDaemonForeground(...args);\n}\n`;
let retained = sf.statements.filter(s => !selected.has(s)).map(s => s.getFullText(sf)).join('\n');
retained = retained.replace('async function runAgenCDaemonForeground(', 'export async function runAgenCDaemonForeground(');
retained += `\nimport { ${selectedNames.join(', ')} } from "./daemon-control.js";\nexport { ${publicNames.join(', ')} } from "./daemon-control.js";\n`;
fs.writeFileSync(path.join(path.dirname(file), 'daemon-control.ts'), control, { flag: 'wx' });
fs.writeFileSync(file, retained);
// Organize imports is purely mechanical: remove original now-unused imports.
for (const target of [file, path.join(path.dirname(file), 'daemon-control.ts')]) {
  const host = {
    getScriptFileNames: () => [target], getScriptVersion: () => '1',
    getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 }),
    getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host);
  const edits = service.organizeImports({ type: 'file', fileName: target }, {}, {});
  let text = fs.readFileSync(target, 'utf8');
  for (const edit of edits.flatMap(e => e.textChanges).sort((a,b)=>b.span.start-a.span.start))
    text = text.slice(0, edit.span.start)+edit.newText+text.slice(edit.span.start+edit.span.length);
  fs.writeFileSync(target, text);
  service.dispose();
}
