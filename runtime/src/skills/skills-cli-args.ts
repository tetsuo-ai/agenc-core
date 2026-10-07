import {
  SKILL_CANDIDATES_DIR_NAME,
  SKILL_CANDIDATES_LEDGER_FILE,
  SKILL_CANDIDATES_ENV,
  isValidSkillCandidateSlug,
} from "./skill-candidate-names.js";

export type AgenCSkillsCliCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "candidates-list"; readonly json: boolean }
  | { readonly kind: "candidates-show"; readonly slug: string }
  | { readonly kind: "candidates-accept"; readonly slug: string }
  | { readonly kind: "candidates-reject"; readonly slug: string }
  | { readonly kind: "error"; readonly message: string };

export const SKILL_CANDIDATES_LISTING_KIND = "agenc.skills.candidates";

/**
 * `agenc skills list [--json]` keeps its original contract: anything else
 * after `list` returns null and falls through to the default route. Once the
 * user has typed `skills candidates`, a malformed rest is reported as an
 * error instead of being handed to a session as a prompt, because three of
 * the four candidate commands move or delete files.
 */
export function parseAgenCSkillsCliArgs(
  argv: readonly string[],
): AgenCSkillsCliCommand | null {
  const [command, subcommand, ...rest] = argv;
  if (command !== "skills") return null;
  if (subcommand === "list") return parseListArgs(rest);
  if (subcommand === "candidates") return parseCandidatesArgs(rest);
  return null;
}

function parseListArgs(rest: readonly string[]): AgenCSkillsCliCommand | null {
  let json = false;
  for (const argument of rest) {
    if (argument === "--json") json = true;
    else return null;
  }
  return { kind: "list", json };
}

function cliError(message: string): AgenCSkillsCliCommand {
  return { kind: "error", message };
}

function parseCandidatesArgs(rest: readonly string[]): AgenCSkillsCliCommand {
  const [action, ...args] = rest;
  switch (action) {
    case "list": {
      let json = false;
      for (const argument of args) {
        if (argument === "--json") json = true;
        else return cliError(`unexpected argument for skills candidates list: ${argument}`);
      }
      return { kind: "candidates-list", json };
    }
    case "show":
    case "accept":
    case "reject": {
      const [slug, ...extra] = args;
      if (slug === undefined) {
        return cliError(`skills candidates ${action} needs a candidate name`);
      }
      if (extra.length > 0) {
        return cliError(
          `unexpected argument for skills candidates ${action}: ${extra[0]}`,
        );
      }
      if (!isValidSkillCandidateSlug(slug)) {
        return cliError(
          `not a skill candidate name (kebab-case letters, digits, hyphens): ${slug}`,
        );
      }
      return { kind: `candidates-${action}`, slug };
    }
    case undefined:
      return cliError(
        "skills candidates needs one of: list [--json], show <name>, accept <name>, reject <name>",
      );
    default:
      return cliError(`unknown skills candidates command: ${action}`);
  }
}

export function formatAgenCSkillsCliHelpText(): string {
  return [
    "Usage: agenc skills <command>",
    "",
    "Commands:",
    "  list [--json]               List every skill this runtime serves (built-in,",
    "                              personal, project, and plugin-shipped), readonly.",
    "  candidates list [--json]    List draft skills the runtime proposed from past",
    "                              sessions. Drafts are inactive until accepted.",
    "  candidates show <name>      Print a draft's SKILL.md.",
    "  candidates accept <name>    Move a draft into $AGENC_HOME/skills/<name>/ so",
    "                              the loader picks it up. Refuses an existing name.",
    "  candidates reject <name>    Delete a draft.",
    "",
    `Drafts live under $AGENC_HOME/${SKILL_CANDIDATES_DIR_NAME}/<name>/ next to a`,
    `${SKILL_CANDIDATES_LEDGER_FILE} audit trail. ${SKILL_CANDIDATES_ENV}=0 stops new proposals.`,
  ].join("\n");
}
