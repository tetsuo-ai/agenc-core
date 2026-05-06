import type { AttachmentProducer } from "./orchestrator.js";
import { formatSkillListingWithinBudget } from "../../skills/local-loader.js";

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export const skillListingProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  if (opts.subagentDepth > 0) return [];
  if (!opts.skillsManager) return [];

  const outcome = await opts.skillsManager.skillsForConfig(opts.config ?? {}, null);
  const skills = outcome.availableSkills ?? [];
  const listing = formatSkillListingWithinBudget(
    skills,
    opts.contextWindowTokens,
  );
  if (listing.length === 0) return [];

  const hash = simpleHash(listing);
  if (trackingState.lastSkillListingHash === hash) return [];
  trackingState.lastSkillListingHash = hash;

  return [
    {
      kind: "skill_listing",
      content: listing,
    },
  ];
};
