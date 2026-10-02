/** Run against a pinned candidate checkout, with its installed TypeScript.
 * Executes actual pure presentation code. Does not pretend to be a CLI capture.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
const root = resolve(process.argv[2]);
const require = createRequire(root + '/package.json');
const ts = require('typescript');
const hashes = {};
function source(path) {
  const raw = readFileSync(root + '/runtime/src/' + path, 'utf8');
  hashes[path] = createHash('sha256').update(raw).digest('hex');
  return raw;
}
function execute(raw, imports = {}) {
  const context = { exports: {}, require: name => {
    if (!(name in imports)) throw new Error('Unexpected dependency: ' + name);
    return imports[name];
  } };
  const js = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, context);
  return context.exports;
}
function extract(path, names) {
  const tree = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  return tree.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.text))))
    .map(n => n.getText(tree)).join('\n');
}
const frames = execute(extract('tools/untrusted-tool-result-framing.ts', ['LIGHT_WORKSPACE_DATA_BOUNDARY','UNTRUSTED_TOOL_RESULT_BOUNDARY']));
const workflow = execute(source('prompts/light-workflow.ts'), { '../tools/untrusted-tool-result-framing.js': frames });
const presentation = execute(source('tools/light-presentation.ts'));
const lean = execute(extract('prompts/lean-system-prompt.ts', ['bullets','getLeanSystemSection','getLeanActionsSection']));
const standard = execute(extract('prompts/system-prompt.ts', ['prependBullets','joinSection','getActionsSection','HEADLESS_DEADLINE_GUIDANCE']));
const result = { source_sha256: hashes, sections: {
  workflow: workflow.lightWorkflow(false), system: lean.getLeanSystemSection(),
  actions_deepseek: standard.getActionsSection(), actions_openai: lean.getLeanActionsSection(),
  deadline: standard.HEADLESS_DEADLINE_GUIDANCE,
}, fixtures: {} };
// Wire schemas supplied as data; the projector preserves their exact format/name.
const fixtures = JSON.parse(readFileSync(process.argv[3], 'utf8'));
for (const [model, body] of Object.entries(fixtures)) {
  result.fixtures[model] = { tools: body.tools.map(wire => {
    const fn = wire.function ?? wire;
    const name = fn.name === 'tool2__system_x2esearchTools' ? 'system.searchTools' : fn.name;
    const parameters = structuredClone(fn.parameters);
    if (name === 'FileRead') parameters.properties.dense_line_numbers = { type: 'boolean', description: 'Number every line in this read instead of sparse numbering.' };
    const converted = presentation.lightPresentation({ type: 'function', function: { ...fn, name, parameters } }).function;
    converted.name = fn.name;
    return wire.function ? { ...wire, function: converted } : { ...wire, ...converted };
  }) };
}
result.memory_example = workflow.lightMemoryContext('/PROJECT/', '/GLOBAL/');
const output = resolve(process.argv[4]);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2));
