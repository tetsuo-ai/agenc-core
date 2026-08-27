import { resolveSessionTempRoot } from "../session/runtime-options.js";
import { getBundledSkillExtractionRoot } from "./bundled-extraction-registry.js";

/**
 * Resolve the one bundled-skill root owned by the current session temp
 * authority.
 *
 * The registry adds a process-local random nonce beneath the captured temp
 * root. That nonce is the load-bearing defense against another local user
 * pre-creating a predictable tree under a shared temp directory. Sticky-bit
 * rules prevent deletion, not creation, and a predictable parent could be
 * swapped or populated before AgenC writes the skill files.
 *
 * Every bundled-skill path consumer, including permission checks, must use
 * this adapter so path construction and authorization cannot diverge. The
 * registry keeps the result stable per captured temp root, bounds ownerless
 * CLI roots, and retires Session-owned roots after the final owner shuts down.
 */
export function getCurrentBundledSkillExtractionRoot(): string {
  return getBundledSkillExtractionRoot(resolveSessionTempRoot());
}
