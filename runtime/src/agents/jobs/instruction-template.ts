/**
 * Instruction template substitution for agent-jobs (reference parity).
 *
 * Port of reference `render_instruction_template`
 * (`core/src/tools/handlers/agent_jobs.rs:1046`). Replaces `{column}`
 * placeholders with values from a CSV row record. `{{` and `}}` are
 * escape sequences that produce literal `{` and `}` in the output.
 *
 * Missing placeholder keys are left unreplaced verbatim, matching
 * reference behavior.
 *
 * @module
 */

import type { CsvRow } from "./csv-reader.js";

const OPEN_BRACE_SENTINEL = "__AGENC_OPEN_BRACE__";
const CLOSE_BRACE_SENTINEL = "__AGENC_CLOSE_BRACE__";

export function renderInstructionTemplate(
  instruction: string,
  row: CsvRow,
): string {
  let rendered = instruction
    .replaceAll("{{", OPEN_BRACE_SENTINEL)
    .replaceAll("}}", CLOSE_BRACE_SENTINEL);
  for (const [key, value] of Object.entries(row)) {
    const placeholder = `{${key}}`;
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered
    .replaceAll(OPEN_BRACE_SENTINEL, "{")
    .replaceAll(CLOSE_BRACE_SENTINEL, "}");
}
