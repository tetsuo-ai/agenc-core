import fs from 'node:fs';
import ts from '/private/tmp/light-takeover/startup-core/node_modules/typescript/lib/typescript.js';
const root = '/private/tmp/light-takeover/startup-core/runtime/src/app-server/';
const controls = ts.createSourceFile('control.ts', fs.readFileSync(root+'daemon-control.ts','utf8'),ts.ScriptTarget.Latest,true);
const types = new Set(controls.statements.filter(s=>ts.isTypeAliasDeclaration(s)||ts.isInterfaceDeclaration(s)).map(s=>s.name.text));
for (const name of ['daemon-cli.ts','daemon-control.ts']) {
  const file = root+name;
  let text = fs.readFileSync(file,'utf8');
  const sf = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const edits = [];
  for (const s of sf.statements) {
    if ((!ts.isImportDeclaration(s)&&!ts.isExportDeclaration(s)) || s.moduleSpecifier?.text !== './daemon-control.js') continue;
    const elements = s.importClause?.namedBindings?.elements ?? s.exportClause?.elements;
    if (!elements) continue;
    const keyword = ts.isImportDeclaration(s) ? 'import' : 'export';
    const value = `${keyword} {\n${elements.map(e=>'  '+(types.has((e.propertyName??e.name).text)?'type ':'')+e.getText(sf).replace(/^type /,'')+',').join('\n')}\n} from "./daemon-control.js";`;
    edits.push({start:s.getStart(sf),end:s.end,value});
  }
  for (const e of edits.reverse()) text=text.slice(0,e.start)+e.value+text.slice(e.end);
  // Only format import blocks affected by the language service organizer.
  const parsed=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const imports=parsed.statements.filter(ts.isImportDeclaration);
  for(const s of imports.reverse()) {
    const raw=s.getText(parsed);
    const fixed=raw.replace(/\{\s*([^{}]+)\s*\}/g,(_all,body)=>{
      const items=body.split(',').map(v=>v.trim()).filter(Boolean);
      return items.length>3 ? '{\n'+items.map(v=>'  '+v+',').join('\n')+'\n}' : '{ '+items.join(', ')+' }';
    });
    text=text.slice(0,s.getStart(parsed))+fixed+text.slice(s.end);
  }
  fs.writeFileSync(file,text);
}
