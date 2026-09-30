// Read-only, source-body audit. Does not execute runtime/builder code or mint contracts.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('/private/tmp/light-ultra/core/node_modules/typescript/lib/typescript.js');
const cwd = '/private/tmp/light-takeover/startup-core';
const before = '2da4a495cf91a59adc97d50d5b8426653187cb4e';
const after = '28e21d055fa052f0f27810bd65f76fd8f6b1ce15';
const sha = b => createHash('sha256').update(b).digest('hex');
const profile = readFileSync('/private/tmp/light-takeover/fair-confirmation/prompt-binding-v2/prompt_binding.py', 'utf8');
if (sha(profile) !== '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6') throw Error('profile source changed');
const pins = Object.fromEntries([...profile.matchAll(/'(runtime\/[^']+)': '([a-f0-9]{64})'/g)].map(m => [m[1], m[2]]));
const git = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd, maxBuffer: 4 * 1024 * 1024 });
const rows = Object.entries(pins).map(([path, pin]) => {
  const old = git(before, path), current = git(after, path);
  return { path, profile_pin: pin, historical_sha256: sha(old), current_sha256: sha(current),
    profile_matches_historical: pin === sha(old), profile_matches_current: pin === sha(current) };
});
const functions = [
  ['runtime/src/llm/wire/responses-openai.ts', 'buildOpenAIResponsesRequest'],
  ['runtime/src/llm/wire/chat-completions.ts', 'buildChatCompletionsRequest'],
  ['runtime/src/session/run-turn-messages.ts', 'buildSeedMessages'],
  ['runtime/src/session/run-turn-attachments.ts', 'placeRetainedAttachments'],
  ['runtime/src/llm/wire/shared-prefix-tail.ts', 'sessionTailReminder'],
  ['runtime/src/llm/wire/shared-prefix-tail.ts', 'afterLeadingSetupReminders'],
];
function extract(ref, path, name) {
  const source = git(ref, path).toString();
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!found) throw Error(`missing ${name}`);
  return { bytes: found.getText(ast), line: ast.getLineAndCharacterOfPosition(found.getStart(ast)).line + 1 };
}
const bodies = functions.map(([path, name]) => {
  const old = extract(before, path, name), current = extract(after, path, name);
  return { path, function: name, current_line: current.line, body_bytes_identical: old.bytes === current.bytes,
    historical_sha256: sha(old.bytes), current_sha256: sha(current.bytes) };
});
console.log(JSON.stringify({ before, after, selected_source_pins: rows, selected_function_bodies: bodies }, null, 2));
