// Mechanical declaration move; original bodies preserved except passed reload authority.
import fs from 'node:fs';
const root = '/private/tmp/light-takeover/startup-core/runtime/src/bin/';
const file = root + 'agenc-main.ts';
let text = fs.readFileSync(file, 'utf8');
const start = text.indexOf('export interface RunSingleTurnOpts {');
const end = text.indexOf('\nfunction resolveUserHome(', start);
if (start < 0 || end < 0) throw new Error('Extraction boundaries absent');
let moved = text.slice(start, end);
moved = moved.replace('  opts: RunSingleTurnOpts,\n): AsyncGenerator',
  '  opts: RunSingleTurnOpts,\n  defaultReload: typeof maybeReloadConfigBetweenTurns,\n): AsyncGenerator');
moved = moved.replace('opts.reloadConfigFn ?? maybeReloadConfigBetweenTurns', 'opts.reloadConfigFn ?? defaultReload');
moved = moved.replace(' * session + ctx and a fresh `input` each iteration. Today `main()`\n * calls it exactly once for the one-shot CLI flow.',
  ' * session + ctx and a fresh `input` each iteration. The daemon-backed\n * one-shot CLI does not load this local compatibility driver.');
const imports = `import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { PhaseEvent } from "../phases/events.js";
import type { Terminal } from "../session/turn-state.js";
import type { LLMContentPart } from "../llm/types.js";
import type { ConfigStore } from "../config/store.js";
import type { ConfigReloadLatch, maybeReloadConfigBetweenTurns } from "./agenc-main.js";
import { runTurn } from "../session/run-turn.js";
import { assembleSystemPrompt, buildAssembleSystemPromptOpts, resolveMemoryPromptInputs,
  type McpServerInstructionsInput } from "../prompts/system-prompt.js";
import { getOutputStyleConfig } from "../constants/outputStyles.js";
import { loadSessionMcpServerInstructions } from "../prompts/mcp-server-instructions.js";

`;
fs.writeFileSync(root + 'local-turn-runtime.ts', imports + moved, { flag: 'wx' });
const wrappers = `export type { RunSingleTurnOpts, PreparedTurnRuntimeInputs } from "./local-turn-runtime.js";

/** Compatibility seam: ordinary daemon-backed startup does not load local execution. */
export async function* runSingleTurn(
  opts: RunSingleTurnOpts,
): AsyncGenerator<PhaseEvent, Terminal | undefined> {
  const runtime = await import("./local-turn-runtime.js");
  return yield* runtime.runSingleTurn(opts, maybeReloadConfigBetweenTurns);
}

export async function prepareTurnRuntimeInputs(
  params: Parameters<typeof import("./local-turn-runtime.js").prepareTurnRuntimeInputs>[0],
): Promise<PreparedTurnRuntimeInputs> {
  const runtime = await import("./local-turn-runtime.js");
  return runtime.prepareTurnRuntimeInputs(params);
}
`;
text = text.slice(0, start) + wrappers + text.slice(end);
text = text.replace('import { runTurn } from "../session/run-turn.js";\n', '');
const promptStart = text.indexOf('import {\n  assembleSystemPrompt,');
const promptEnd = text.indexOf('import { clearSystemPromptSections }', promptStart);
if (promptStart < 0 || promptEnd < 0) throw new Error('Prompt import block absent');
text = text.slice(0, promptStart) + 'import type { PreparedTurnRuntimeInputs, RunSingleTurnOpts } from "./local-turn-runtime.js";\n' + text.slice(promptEnd);
fs.writeFileSync(file, text);
