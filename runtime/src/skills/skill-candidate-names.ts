/** Sibling of `<AGENC_HOME>/skills`; never a skills root. */
export const SKILL_CANDIDATES_DIR_NAME = "skill-candidates";
export const SKILL_CANDIDATES_LEDGER_FILE = "ledger.jsonl";
/** `AGENC_SKILL_CANDIDATES=0` switches proposals off. */
export const SKILL_CANDIDATES_ENV = "AGENC_SKILL_CANDIDATES";

export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isValidSkillCandidateSlug(value: string): boolean {
  return (
    value.length >= MIN_SLUG_LENGTH &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}
