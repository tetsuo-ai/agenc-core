/**
 * Product-help attachment producer.
 *
 * Every head is resent on every model call, so built-in help that only a few
 * user messages need stays out of it. When the root human message of the
 * current turn asks how to undo, revert, roll back or restore work, the
 * producer sends the undo paths (/rewind checkpoints, their limits, Git
 * history), in every session. In a Light session, when it mentions
 * instruction files and none is loaded, it names AgenC's (AGENC.md) and says
 * none is loaded; loaded instruction files already say where they are
 * (prompts/live-instructions.ts), and the standard and lean heads name AGENC.md
 * themselves.
 * Each topic goes once, on the turn's first request. The retention ledger
 * anchors the reminder before that message and replays it in place on every
 * later request, so the cached prefix never moves and the text is not sent
 * twice.
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import { AGENC_INSTRUCTION_FILE, AGENC_UNDO_PATHS, LIGHT_LOADED_INSTRUCTIONS_NOTE } from "../product-help.js";
import type { AttachmentProducer } from "./orchestrator.js";

/**
 * Undo, revert and restore wording, in English and a few common languages.
 * A false match costs one short reminder; a miss leaves the model without the
 * /rewind facts for that answer.
 */
const UNDO_REQUEST =
  /\b(?:undo(?:ne|ing)?|rewind|revert(?:ed|ing|s)?|restor(?:e|ed|es|ing)|roll(?:ed|ing)?[ -]?back|rollbacks?|checkpoints?|take (?:it|that|this|them) back|go(?:ing)? back to (?:a |an |the )?(?:previous|earlier|older|last|prior|original)|(?:previous|earlier|older|prior) version|back out|get (?:my|the) (?:old|previous|original) (?:code|files?|version|changes?) back|reset (?:my|the|your|all|these|those) (?:changes|edits|work|files?|code))\b|\/rewind|rückgängig|deshacer|annuler|desfazer|annulla|元に戻|撤销|撤回|되돌리/iu;

/** Whether `text` asks about undoing or restoring work. */
export function asksAboutUndo(text: string): boolean {
  return UNDO_REQUEST.test(text);
}

/** Instruction files, AgenC's or another assistant's, or the assistant's own instructions. */
const INSTRUCTIONS_REQUEST =
  /\b(?:AGENC\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|instructions? files?|(?:your|project|custom|system) instructions|system prompt)\b/iu;

/** Whether `text` is about instruction files. */
export function asksAboutInstructionFiles(text: string): boolean {
  return INSTRUCTIONS_REQUEST.test(text);
}

const TOPICS = [
  { topic: "undo", matches: asksAboutUndo, text: AGENC_UNDO_PATHS, light: true, standard: true },
  { topic: "instructions", matches: asksAboutInstructionFiles, text: AGENC_INSTRUCTION_FILE, light: true, standard: false },
] as const;

function contains(messages: readonly LLMMessage[], needle: string): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") return message.content.includes(needle);
    return message.content.some((part) =>
      (part as { type?: string }).type === "text" &&
      ((part as { text?: string }).text ?? "").includes(needle));
  });
}

/**
 * Loaded instruction files say where they are: in the instructions sent with
 * this request, or in an instruction update reminder already in the history.
 */
function instructionFilesLoaded(opts: Parameters<AttachmentProducer>[0]): boolean {
  return opts.lightInstructionFilesLoaded === true || contains(opts.messages, LIGHT_LOADED_INSTRUCTIONS_NOTE);
}

export const productHelpProducer: AttachmentProducer = async (opts) => {
  const light = opts.lightMode === true;
  // Only the human's own message decides; a synthetic follow-up or a
  // delegated child turn carries no root-human text for this turn.
  const provenance = opts.turnProvenance;
  const root = provenance?.rootHumanTurn;
  if (provenance === undefined || root === null || root === undefined ||
      root.turnId !== provenance.turnId) {
    return [];
  }
  // Each topic once: a copy already in front of the model (retained from an
  // earlier request or turn) suppresses it.
  return TOPICS
    .filter((entry) => (light ? entry.light : entry.standard) && entry.matches(root.text) &&
      !contains(opts.messages, entry.text) &&
      !(entry.topic === "instructions" && instructionFilesLoaded(opts)))
    .map(({ topic }) => ({ kind: "product_help", topic }));
};
