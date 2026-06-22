/**
 * `/help` - list registered slash commands grouped by category.
 *
 * Reads the global command registry installed by runtime entry points.
 * Until the registry is wired, emits a "registry pending" notice so the
 * command itself is safe to land standalone.
 *
 * @module
 */

import {
  getGlobalCommandRegistry,
  safeExecute,
  type CommandRegistry,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import React from "react";
import {
  CUSTOM_COMMANDS_TITLE,
  HELP_WORKFLOW_GROUPS,
  OTHER_COMMANDS_TITLE,
  helpWorkflowTitleForCommand,
} from "./help-groups.js";
import { openAsyncLocalJsxCommand } from "./local-jsx-command.js";
import { sanitizeSuggestionMetadataText } from "../utils/suggestions/sanitizeSuggestionMetadataText.js";

export interface HelpCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly isEnabled?: () => boolean;
  readonly isHidden?: boolean;
  readonly userInvocable?: boolean;
  readonly type?: string;
  readonly kind?: string;
  readonly loadedFrom?: string;
  readonly source?: string;
  readonly pluginInfo?: {
    readonly pluginManifest?: {
      readonly name?: string;
    };
  };
}

export interface HelpCommandGroup {
  readonly title: string;
  readonly commands: readonly HelpCommand[];
}

export interface HelpFormatOptions {
  readonly builtInCommandNames?: ReadonlySet<string>;
}

/**
 * Group visible, deduplicated slash commands.
 *
 * This mirrors the upstream HelpV2 command list behavior in AgenC's
 * text-only slash-command surface: hidden/disabled commands are excluded,
 * custom commands split from built-ins, duplicate command names collapse to
 * the first entry, and display order is stable within each category.
 */
export function groupHelpCommands(
  commands: readonly HelpCommand[],
  options: HelpFormatOptions = {},
): readonly HelpCommandGroup[] {
  const grouped = new Map<string, HelpCommand[]>();
  const seen = new Set<string>();

  for (const command of commands) {
    if (command.userInvocable === false) continue;
    if (command.isHidden === true) continue;
    if (command.isEnabled?.() === false) continue;

    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const title = helpWorkflowTitleForCommand(
      command,
      options.builtInCommandNames,
    );
    const bucket = grouped.get(title);
    if (bucket) {
      bucket.push(command);
    } else {
      grouped.set(title, [command]);
    }
  }

  const groups: HelpCommandGroup[] = [];
  for (const category of HELP_WORKFLOW_GROUPS) {
    const commands = grouped.get(category.title);
    if (!commands || commands.length === 0) continue;
    groups.push({
      title: category.title,
      commands: [...commands].sort(compareCommandNames),
    });
  }

  const otherCommands = grouped.get(OTHER_COMMANDS_TITLE);
  if (otherCommands && otherCommands.length > 0) {
    groups.push({
      title: OTHER_COMMANDS_TITLE,
      commands: [...otherCommands].sort(compareCommandNames),
    });
  }

  const customCommands = grouped.get(CUSTOM_COMMANDS_TITLE);
  if (customCommands && customCommands.length > 0) {
    groups.push({
      title: CUSTOM_COMMANDS_TITLE,
      commands: [...customCommands].sort(compareCommandNames),
    });
  }

  return groups;
}

/** Format the registry as a grouped plain-text help block. */
export function formatHelp(reg: CommandRegistry): string {
  return formatHelpCommands(reg.list());
}

/** Format any command surface as a grouped plain-text help block. */
export function formatHelpCommands(
  commands: readonly HelpCommand[],
  options: HelpFormatOptions = {},
): string {
  const groups = groupHelpCommands(commands, options);
  if (groups.length === 0) return "No slash commands registered.";

  const lines: string[] = ["Available commands:"];
  for (const group of groups) {
    lines.push("", `${group.title}:`);
    for (const command of group.commands) {
      lines.push(
        `  ${formatCommandNames(command)} - ${formatDescription(command)}`,
      );
    }
  }
  return lines.join("\n");
}

function compareCommandNames(left: HelpCommand, right: HelpCommand): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function formatCommandNames(command: HelpCommand): string {
  return [command.name, ...(command.aliases ?? [])]
    .map((name) => `/${name}`)
    .join(", ");
}

function formatDescription(command: HelpCommand): string {
  return sanitizeSuggestionMetadataText(formatRawDescription(command));
}

function formatRawDescription(command: HelpCommand): string {
  const description = command.description ?? "";
  if (command.type !== "prompt") return description;
  if (command.kind === "workflow") return `${description} (workflow)`;
  if (command.source === "plugin") {
    const pluginName = command.pluginInfo?.pluginManifest?.name;
    return pluginName
      ? `(${pluginName}) ${description}`
      : `${description} (plugin)`;
  }
  if (command.source === "bundled") return `${description} (bundled)`;
  if (
    !command.source ||
    command.source === "builtin" ||
    command.source === "mcp"
  ) {
    return description;
  }
  return `${description} (${command.source})`;
}

async function loadHelpCommandSurface(
  cwd: string,
  fallbackRegistry: CommandRegistry,
): Promise<{
  readonly commands: readonly HelpCommand[];
  readonly builtInCommandNames?: ReadonlySet<string>;
}> {
  void cwd;
  return {
    commands: fallbackRegistry.list(),
    builtInCommandNames: new Set(
      fallbackRegistry.list().flatMap(command => [
        command.name,
        ...(command.aliases ?? []),
      ]),
    ),
  };
}

export function normalizeHelpQuery(argsRaw: string): string {
  return argsRaw
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function filterHelpCommands(
  commands: readonly HelpCommand[],
  query: string,
  options: HelpFormatOptions = {},
): readonly HelpCommand[] {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;

  if (terms.length === 1) {
    const exact = commands.filter((command) =>
      [command.name, ...(command.aliases ?? [])]
        .map(name => name.toLowerCase())
        .includes(terms[0]!),
    );
    if (exact.length > 0) return exact;
  }

  return commands.filter((command) => {
    const haystack = [
      command.name,
      ...(command.aliases ?? []),
      command.description ?? "",
      helpWorkflowTitleForCommand(command, options.builtInCommandNames),
    ].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

async function openHelpMenu(
  ctx: SlashCommandContext,
  commands: readonly HelpCommand[],
  query: string,
): Promise<boolean> {
  return openAsyncLocalJsxCommand(ctx, async close => {
    const { HelpV2 } = await import("../tui/components/HelpV2/HelpV2.js");
    return React.createElement(HelpV2, {
      commands: commands as never,
      query,
      onClose: close,
    });
  });
}

export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show help and available commands",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      // Prefer the registry the dispatcher passed in. The TUI dispatch
      // path (App.tsx) builds a fresh registry per-call and does not
      // call setGlobalCommandRegistry, so falling through to the global
      // slot returned the "registry pending" placeholder for every
      // /help invocation. Use ctx.commandRegistry first, fall back to
      // the global, and only emit the placeholder when neither is
      // available.
      const reg = ctx.commandRegistry ?? getGlobalCommandRegistry();
      if (!reg) {
        return { kind: "text", text: "registry pending" };
      }
      const surface = await loadHelpCommandSurface(ctx.cwd, reg);
      const query = normalizeHelpQuery(ctx.argsRaw);
      const commands = filterHelpCommands(surface.commands, query, {
        builtInCommandNames: surface.builtInCommandNames,
      });
      if (await openHelpMenu(ctx, commands, query)) {
        return { kind: "skip" };
      }
      return {
        kind: "text",
        text: formatHelpCommands(commands, {
          builtInCommandNames: surface.builtInCommandNames,
        }),
      };
    }),
};
