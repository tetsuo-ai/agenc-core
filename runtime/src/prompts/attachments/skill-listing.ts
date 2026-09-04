import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import {
  buildSkillListingWithinBudget,
  rankSkillsForRequest,
  type SkillListingEntry,
} from "../../skills/local-loader.js";

/** Relevance lines per request, small enough to keep in the prompt. */
const RELEVANCE_LIMIT = 12;

function messageCarriesText(message: LLMMessage, needle: string): boolean {
  if (typeof message.content === "string") {
    return message.content.includes(needle);
  }
  return message.content.some(
    (part) => part.type === "text" && part.text.includes(needle),
  );
}

/**
 * Skills registered through `registerBundledSkill` (browser-automation, the
 * marketplace kit installer) live outside the local loader, but the Skill
 * tool loads them, so the model must hear about them too. Dynamic literal
 * import with a catch, as in /skills: in tests the build-time MACRO global
 * is absent and registration throws at module load, in which case the
 * listing simply omits them.
 */
async function bundledRegistrySkills(): Promise<readonly SkillListingEntry[]> {
  try {
    const { getBundledSkills } = await import("../../skills/bundledSkills.js");
    return getBundledSkills().flatMap((command): SkillListingEntry[] =>
      command.isEnabled?.() === false
        ? []
        : [{
            name: command.name,
            description: command.description,
            ...(command.whenToUse !== undefined
              ? { whenToUse: command.whenToUse }
              : {}),
            disableModelInvocation: command.disableModelInvocation === true,
            loadedFrom: "bundled",
          }],
    );
  } catch {
    return [];
  }
}

/**
 * The listing is emitted once per session and then retained in the projection
 * (session/attachment-retention.ts), so the absence check against the
 * request's messages holds across turns and the listing's bytes stay in the
 * cached prefix. Later requests that name skills the listing had no room for
 * get a small relevance block instead, and every name shown is remembered so
 * neither block repeats itself.
 */
export const skillListingProducer: AttachmentProducer = async (opts, tracking) => {
  if (opts.subagentDepth > 0) return [];
  if (!opts.skillsManager) return [];
  const listingPresent = opts.messages.some((message) =>
    messageCarriesText(message, SKILL_LISTING_REMINDER_HEADER),
  );

  const outcome = await opts.skillsManager.skillsForConfig(opts.config ?? {}, null);
  const skills = outcome.availableSkills ?? [];
  // Roots that hold more skills than the per-root cap loaded: those never
  // reached the listing at all, so a truncated listing is only half the story.
  const truncatedRoots = (outcome.truncatedSkillRoots ?? []).filter(
    (root) => root.droppedCount > 0,
  );
  const known = new Set(skills.map((skill) => skill.name));
  const bundled = (await bundledRegistrySkills()).filter(
    (skill) => !known.has(skill.name),
  );
  const catalog = [...skills, ...bundled];
  if (listingPresent) {
    const relevant = rankSkillsForRequest(
      catalog,
      opts.userInput,
      tracking.listedSkillNames,
      RELEVANCE_LIMIT,
    );
    if (relevant.lines.length === 0) return [];
    for (const name of relevant.names) tracking.listedSkillNames.add(name);
    return [{ kind: "skill_relevance", content: relevant.lines.join("\n") }];
  }
  const { listing, stats, listedNames } = buildSkillListingWithinBudget(
    catalog,
    opts.contextWindowTokens,
    // What the user just asked for decides which skills get the budget when
    // the installed catalog does not fit.
    opts.userInput,
  );
  for (const name of listedNames) tracking.listedSkillNames.add(name);
  // What the model was shown is otherwise unrecoverable: the listing is an
  // attachment, so it never reaches the rollout, and the provider trace keeps
  // no message bodies. A run where the model ignored every skill could not be
  // told apart from one where it was shown none of the right ones.
  if (stats.hidden > 0 || truncatedRoots.length > 0) {
    opts.emitDiagnostic?.({
      cause: "skill_listing_truncated",
      message:
        `listed ${stats.listed} of ${stats.invocable} invocable skills ` +
        `(${stats.usedChars}/${stats.budgetChars} chars, ` +
        `${stats.ranked ? "ranked by this request" : "unranked"})` +
        (truncatedRoots.length > 0
          ? `; ${truncatedRoots.reduce((sum, root) => sum + root.droppedCount, 0)} more were never loaded: ` +
            truncatedRoots
              .map((root) => `${root.root} holds ${root.droppedCount} past the per-root cap`)
              .join(", ")
          : ""),
    });
  }
  if (listing.length === 0) return [];

  return [
    {
      kind: "skill_listing",
      content: listing,
    },
  ];
};
