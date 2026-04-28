/**
 * Slash-command typeahead suggestions for the composer footer.
 *
 * Ported from upstream. Upstream uses `fuse.js` for fuzzy ranking;
 * AgenC keeps the dependency footprint small and uses a deterministic
 * exact/prefix/substring rank instead. The ranking tiers are:
 *
 *   1. Exact name match
 *   2. Exact alias match
 *   3. Prefix name match (shorter wins)
 *   4. Prefix alias match (shorter wins)
 *   5. Substring name match
 *   6. Substring description match
 *
 * Pulls live commands from AgenC's slash-command registry via
 * `tui/_deps/commands.ts`.
 *
 * The `MidInputSlashCommand` / `findMidInputSlashCommand` helpers
 * surface a slash command typed mid-input (preceded by whitespace),
 * which feeds the inline ghost-text completion.
 *
 * Outputs `SuggestionItem`s consumed by
 * `composer/PromptInputFooterSuggestions`. Composer hosts that route
 * suggestions through the existing `Palette` widget should use
 * `palette-sources::getSlashCommandItems` instead.
 */
import {
  getGlobalCommandRegistry,
  type SlashCommandLike,
} from "../../_deps/commands.js";
import type { SuggestionItem } from "../PromptInputFooterSuggestions.js";

/**
 * Lightweight command shape consumed by this module. Mirrors the
 * upstream `Command` interface with the AgenC-relevant fields. The
 * suggestion sources work on any object that satisfies this shape so
 * tests can pass synthetic command lists.
 */
export interface CommandLike extends SlashCommandLike {
  /** Optional aliases array. */
  readonly aliases?: readonly string[];
  /** Optional `userInvocable: false` hides the command from suggestions. */
  readonly userInvocable?: boolean;
  /** Source bucket used for grouping (built-in vs user/project). */
  readonly source?:
    | "userSettings"
    | "localSettings"
    | "projectSettings"
    | "policySettings"
    | "plugin"
    | "builtin";
  /** True for prompt-style workflow commands. */
  readonly kind?: "workflow" | "prompt" | "command";
  /** Optional argument names; presence implies the command takes args. */
  readonly argNames?: readonly string[];
  /** Hidden from listing entirely. */
  readonly isHidden?: boolean;
}

function getCommandName(cmd: CommandLike): string {
  return cmd.name;
}

function isHidden(cmd: CommandLike): boolean {
  return cmd.isHidden === true || cmd.userInvocable === false;
}

/** Snapshot of the live command registry, or `[]` when none is wired. */
export function getRegisteredCommands(): readonly CommandLike[] {
  const reg = getGlobalCommandRegistry();
  if (!reg) return [];
  try {
    return reg.list() as readonly CommandLike[];
  } catch {
    return [];
  }
}

export interface MidInputSlashCommand {
  /** The full slash token, e.g. `/com`. */
  readonly token: string;
  /** Position of `/` inside the input string. */
  readonly startPos: number;
  /** The command portion after the slash, e.g. `com`. */
  readonly partialCommand: string;
}

/**
 * Find a slash-command token that appears mid-input (not at index 0).
 * The slash must be preceded by whitespace and the cursor must sit at
 * or before the end of the command portion.
 */
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  if (input.startsWith("/")) return null;

  const beforeCursor = input.slice(0, cursorOffset);
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/);
  if (!match || match.index === undefined) return null;

  const slashPos = match.index + 1;
  const textAfterSlash = input.slice(slashPos + 1);
  const commandMatch = textAfterSlash.match(/^[a-zA-Z0-9_:-]*/);
  const fullCommand = commandMatch ? commandMatch[0] : "";

  if (cursorOffset > slashPos + 1 + fullCommand.length) return null;

  return {
    token: "/" + fullCommand,
    startPos: slashPos,
    partialCommand: fullCommand,
  };
}

/**
 * Returns the completion suffix when the partial command unambiguously
 * extends a known command name. Used by the inline ghost-text
 * pipeline.
 */
export function getBestCommandMatch(
  partialCommand: string,
  commands: readonly CommandLike[],
): { suffix: string; fullCommand: string } | null {
  if (!partialCommand) return null;

  const suggestions = generateCommandSuggestions(
    "/" + partialCommand,
    commands,
  );
  if (suggestions.length === 0) return null;

  const query = partialCommand.toLowerCase();
  for (const suggestion of suggestions) {
    if (!isCommandMetadata(suggestion.metadata)) continue;
    const name = getCommandName(suggestion.metadata);
    if (name.toLowerCase().startsWith(query)) {
      const suffix = name.slice(partialCommand.length);
      if (suffix) return { suffix, fullCommand: name };
    }
  }
  return null;
}

export function isCommandInput(input: string): boolean {
  return input.startsWith("/");
}

export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false;
  if (!input.includes(" ")) return false;
  if (input.endsWith(" ")) return false;
  return true;
}

export function formatCommand(command: string): string {
  return `/${command} `;
}

function isCommandMetadata(metadata: unknown): metadata is CommandLike {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "name" in metadata &&
    typeof (metadata as { name: unknown }).name === "string"
  );
}

function getCommandId(cmd: CommandLike): string {
  const name = getCommandName(cmd);
  if (cmd.source) return `${name}:${cmd.source}`;
  return name;
}

function findMatchedAlias(
  query: string,
  aliases?: readonly string[],
): string | undefined {
  if (!aliases || aliases.length === 0 || query === "") return undefined;
  return aliases.find((alias) => alias.toLowerCase().startsWith(query));
}

function formatDescription(cmd: CommandLike): string {
  const desc = cmd.description ?? "";
  if (cmd.argNames && cmd.argNames.length > 0) {
    return `${desc} (arguments: ${cmd.argNames.join(", ")})`;
  }
  return desc;
}

function createCommandSuggestionItem(
  cmd: CommandLike,
  matchedAlias?: string,
): SuggestionItem {
  const commandName = getCommandName(cmd);
  const aliasText = matchedAlias ? ` (${matchedAlias})` : "";
  const isWorkflow = cmd.kind === "workflow";

  return {
    id: getCommandId(cmd),
    displayText: `/${commandName}${aliasText}`,
    tag: isWorkflow ? "workflow" : undefined,
    description: formatDescription(cmd),
    metadata: cmd,
  };
}

function ensureUniqueSuggestionIds(items: SuggestionItem[]): SuggestionItem[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const seen = counts.get(item.id) ?? 0;
    counts.set(item.id, seen + 1);
    if (seen === 0) return item;
    return { ...item, id: `${item.id}#${seen + 1}` };
  });
}

interface RankedCommand {
  readonly cmd: CommandLike;
  readonly matchedAlias: string | undefined;
  readonly tier: number;
  readonly tieBreak: number;
}

/**
 * Rank tiers (lower is better):
 *   0 — exact name match
 *   1 — exact alias match
 *   2 — prefix name match (tieBreak = name length)
 *   3 — prefix alias match (tieBreak = alias length)
 *   4 — substring name match
 *   5 — substring description match
 */
function rankCommand(cmd: CommandLike, query: string): RankedCommand | null {
  const name = getCommandName(cmd).toLowerCase();
  const aliases = (cmd.aliases ?? []).map((alias) => alias.toLowerCase());

  if (name === query) {
    return { cmd, matchedAlias: undefined, tier: 0, tieBreak: 0 };
  }
  for (const alias of aliases) {
    if (alias === query) {
      return {
        cmd,
        matchedAlias: alias,
        tier: 1,
        tieBreak: alias.length,
      };
    }
  }
  if (name.startsWith(query)) {
    return { cmd, matchedAlias: undefined, tier: 2, tieBreak: name.length };
  }
  for (const alias of aliases) {
    if (alias.startsWith(query)) {
      return { cmd, matchedAlias: alias, tier: 3, tieBreak: alias.length };
    }
  }
  if (name.includes(query)) {
    return { cmd, matchedAlias: undefined, tier: 4, tieBreak: name.length };
  }
  const description = (cmd.description ?? "").toLowerCase();
  if (description.includes(query)) {
    return {
      cmd,
      matchedAlias: undefined,
      tier: 5,
      tieBreak: description.length,
    };
  }
  return null;
}

/** Generate command suggestions for the current composer input. */
export function generateCommandSuggestions(
  input: string,
  commands: readonly CommandLike[],
): SuggestionItem[] {
  if (!isCommandInput(input)) return [];
  if (hasCommandArgs(input)) return [];

  const query = input.slice(1).toLowerCase().trim();

  if (query === "") {
    const visibleCommands = commands.filter((cmd) => !isHidden(cmd));
    const builtinCommands: CommandLike[] = [];
    const userCommands: CommandLike[] = [];
    const projectCommands: CommandLike[] = [];
    const policyCommands: CommandLike[] = [];
    const otherCommands: CommandLike[] = [];

    visibleCommands.forEach((cmd) => {
      if (cmd.source === "userSettings" || cmd.source === "localSettings") {
        userCommands.push(cmd);
      } else if (cmd.source === "projectSettings") {
        projectCommands.push(cmd);
      } else if (cmd.source === "policySettings") {
        policyCommands.push(cmd);
      } else if (cmd.source === undefined || cmd.source === "builtin") {
        builtinCommands.push(cmd);
      } else {
        otherCommands.push(cmd);
      }
    });

    const sortAlpha = (a: CommandLike, b: CommandLike): number =>
      getCommandName(a).localeCompare(getCommandName(b));

    builtinCommands.sort(sortAlpha);
    userCommands.sort(sortAlpha);
    projectCommands.sort(sortAlpha);
    policyCommands.sort(sortAlpha);
    otherCommands.sort(sortAlpha);

    return ensureUniqueSuggestionIds(
      [
        ...builtinCommands,
        ...userCommands,
        ...projectCommands,
        ...policyCommands,
        ...otherCommands,
      ].map((cmd) => createCommandSuggestionItem(cmd)),
    );
  }

  const ranked: RankedCommand[] = [];
  for (const cmd of commands) {
    if (isHidden(cmd)) continue;
    const r = rankCommand(cmd, query);
    if (r) ranked.push(r);
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.tieBreak - b.tieBreak;
  });

  return ensureUniqueSuggestionIds(
    ranked.map((r) => createCommandSuggestionItem(r.cmd, r.matchedAlias)),
  );
}

/**
 * Apply a selected command to the input — replaces the buffer with
 * `/<name> ` and submits immediately when `shouldExecute` is true and
 * the command takes no arguments.
 */
export function applyCommandSuggestion(
  suggestion: string | SuggestionItem,
  shouldExecute: boolean,
  commands: readonly CommandLike[],
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void,
): void {
  let commandName: string;
  let commandObj: CommandLike | undefined;
  if (typeof suggestion === "string") {
    commandName = suggestion;
    commandObj = shouldExecute
      ? commands.find((cmd) => getCommandName(cmd) === commandName)
      : undefined;
  } else {
    if (!isCommandMetadata(suggestion.metadata)) return;
    commandName = getCommandName(suggestion.metadata);
    commandObj = suggestion.metadata as CommandLike;
  }

  const newInput = formatCommand(commandName);
  onInputChange(newInput);
  setCursorOffset(newInput.length);

  if (shouldExecute && commandObj) {
    const argCount = commandObj.argNames?.length ?? 0;
    if (argCount === 0) {
      onSubmit(newInput, true);
    }
  }
}

/**
 * Find every `/command` span in `text` for inline highlighting. The
 * slash must be preceded by whitespace or sit at start-of-string —
 * this avoids matching paths like `/usr/bin`.
 */
export function findSlashCommandPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];
  const regex = /(^|[\s])(\/[a-zA-Z][a-zA-Z0-9:\-_]*)/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const precedingChar = match[1] ?? "";
    const commandName = match[2] ?? "";
    const start = match.index + precedingChar.length;
    positions.push({ start, end: start + commandName.length });
  }
  return positions;
}
