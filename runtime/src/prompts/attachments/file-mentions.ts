/**
 * File-mention attachment producer.
 *
 * Ports the upstream donor `src/utils/attachments.ts:2994-3230`
 * (`generateFileAttachment()` and the `at-mention` call path) onto
 * AgenC's existing prompt-safe `@path` resolver in
 * `runtime/src/prompts/file-mentions.ts`.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC already has UI-free path validation, root checks, and prompt
 *     rendering helpers; this producer wires those helpers into the
 *     per-turn attachment pipeline so every `Session.runTurn()` caller
 *     gets the same model-visible file context.
 *
 * Cross-cuts deliberately NOT carried:
 *   - PDF and image-specific attachment variants are owned by TL-17/TL-18.
 *
 * @module
 */

import { expandFileMentions } from "../file-mentions.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { FileMentionContextAttachment } from "./types.js";

function alreadyContainsFileMentionContext(input: string): boolean {
  return input.includes("<attached_files>") && input.includes("</attached_files>");
}

export const fileMentionsProducer: AttachmentProducer = async (opts) => {
  const input = opts.userInput;
  if (opts.signal.aborted || input === null || !input.includes("@")) {
    return [];
  }
  if (alreadyContainsFileMentionContext(input)) {
    return [];
  }

  const expansion = await expandFileMentions(input, {
    cwd: opts.cwd,
    allowedRoots: opts.fileMentionAllowedRoots,
  });
  if (expansion.attachments.length === 0) {
    return [];
  }

  const attachment: FileMentionContextAttachment = {
    kind: "file_mention",
    files: expansion.attachments,
  };
  return [attachment];
};
