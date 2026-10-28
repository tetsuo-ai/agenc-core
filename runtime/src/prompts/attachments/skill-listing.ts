import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { SKILL_LISTING_REMINDER_HEADER } from "./messages.js";
import {
  SKILL_TOOL_NAME,
  sessionToolPolicyAllowsBundledSkill,
  type SessionToolPolicy,
} from "../../permissions/session-tool-policy.js";
import {
  buildSkillListingWithinBudget,
  rankSkillsForRequest,
  type SkillListingEntry,
} from "../../skills/local-loader.js";

/** Relevance lines per root-human turn, small enough to keep in the prompt. */
const RELEVANCE_LIMIT = 12;

/**
 * Ceiling of a Light session's listing: about a dozen lines at the
 * 120-character description cap, as many as one relevance reminder names.
 * Later human turns still get a relevance reminder for skills it left out.
 */
export const LIGHT_SKILL_LISTING_MAX_CHARS = 2_000;

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
 *
 * What the listing names is what the session may load: a session with a
 * toolPolicy is told only about the bundled skills it enabled, and a skill
 * that is unlisted by default (the kit installer) appears only once the
 * operator has turned it on in config.
 */
async function bundledRegistrySkills(
  toolPolicy: SessionToolPolicy | undefined,
  config: unknown,
): Promise<readonly SkillListingEntry[]> {
  try {
    const { getBundledSkills, isBundledSkillListed } = await import(
      "../../skills/bundledSkills.js"
    );
    return getBundledSkills().flatMap((command): SkillListingEntry[] =>
      command.isEnabled?.() === false ||
      !sessionToolPolicyAllowsBundledSkill(toolPolicy, command.name) ||
      !isBundledSkillListed(command.name, config)
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
 * cached prefix. Later human turns can get one relevance block instead. Tool
 * continuations must not drain another batch of matching skills on each sample.
 * An absent listing is restored even after compaction or durable resume, when
 * the in-memory ledger and authoritative root-human provenance may be absent.
 *
 * A Light session starts without the Skill tool. An invocable installed skill
 * loads its schema before sampling, so invoking the skill does not depend on
 * model-driven tool discovery. The initial listing still names only installed
 * skills within LIGHT_SKILL_LISTING_MAX_CHARS. A session without an installed
 * skill gets neither this listing nor an extra tool schema.
 */
export const skillListingProducer: AttachmentProducer = async (opts, tracking) => {
  if (opts.subagentDepth > 0) return [];
  let skillToolListed = opts.loadedTools.some(tool => tool.function.name === "Skill");
  const lightBeforeSkill = opts.lightMode === true && !skillToolListed;
  if (!opts.skillsManager) return [];
  // A session whose policy leaves out the Skill tool cannot load anything the
  // listing would name.
  if (
    opts.toolPolicy !== undefined &&
    !opts.toolPolicy.enabledTools.includes(SKILL_TOOL_NAME)
  ) {
    return [];
  }
  if (opts.signal.aborted) return [];
  const listingPresent = opts.messages.some((message) =>
    messageCarriesText(message, SKILL_LISTING_REMINDER_HEADER),
  );
  const provenance = opts.turnProvenance;
  const rootHumanTurn = provenance?.rootHumanTurn;
  const rootTurnId = provenance?.turnId && rootHumanTurn?.turnId === provenance.turnId
    ? provenance.turnId
    : undefined;
  // A resumed session may retain the listing but have a fresh registry. Load
  // its invocation schema before the ordinary listing deduplication below.
  const needsSkillTool = !skillToolListed && opts.ensureSkillTool !== undefined;
  if (!needsSkillTool && listingPresent && (rootTurnId === undefined ||
    tracking.lastSkillListingRootTurnId === rootTurnId)) return [];

  const outcome = await opts.skillsManager.skillsForConfig(opts.config ?? {}, null);
  const skills = outcome.availableSkills ?? [];
  if (opts.signal.aborted) return [];
  if (needsSkillTool && skills.some(skill =>
    skill.loadedFrom !== "bundled" && skill.disableModelInvocation !== true)) {
    skillToolListed = opts.ensureSkillTool!();
  }
  // Roots that hold more skills than the per-root cap loaded: those never
  // reached the listing at all, so a truncated listing is only half the story.
  const truncatedRoots = (outcome.truncatedSkillRoots ?? []).filter(
    (root) => root.droppedCount > 0,
  );
  const known = new Set(skills.map((skill) => skill.name));
  const catalog = lightBeforeSkill
    ? skills.filter((skill) => skill.loadedFrom !== "bundled" && skill.disableModelInvocation !== true)
    : [...skills, ...(await bundledRegistrySkills(opts.toolPolicy, opts.config)).filter(
      (skill) => !known.has(skill.name),
    )];
  if (opts.signal.aborted) return [];
  if (lightBeforeSkill && catalog.length === 0) return [];
  if (listingPresent) {
    // Recheck after awaiting catalog loading: concurrent preparations of one
    // human turn may have claimed its evaluation while this one was waiting.
    if (rootTurnId === undefined || tracking.lastSkillListingRootTurnId === rootTurnId) return [];
    tracking.lastSkillListingRootTurnId = rootTurnId;
    const relevant = rankSkillsForRequest(
      catalog,
      rootHumanTurn!.text,
      tracking.listedSkillNames,
      RELEVANCE_LIMIT,
    );
    if (relevant.lines.length === 0) return [];
    for (const name of relevant.names) tracking.listedSkillNames.add(name);
    return [{ kind: "skill_relevance", content: relevant.lines.join("\n"), ...(skillToolListed ? { skillToolListed } : {}) }];
  }
  const { listing, stats, listedNames } = buildSkillListingWithinBudget(
    catalog,
    opts.contextWindowTokens,
    // What the user just asked for decides which skills get the budget when
    // the installed catalog does not fit.
    opts.userInput,
    lightBeforeSkill ? LIGHT_SKILL_LISTING_MAX_CHARS : undefined,
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
  if (rootTurnId !== undefined) tracking.lastSkillListingRootTurnId = rootTurnId;

  return [
    {
      kind: "skill_listing",
      content: listing,
      ...(skillToolListed ? { skillToolListed } : {}),
    },
  ];
};
