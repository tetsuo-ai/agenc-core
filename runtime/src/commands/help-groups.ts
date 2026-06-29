export interface HelpWorkflowCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface HelpWorkflowGroup {
  readonly title: string;
  readonly commands: readonly string[];
}

export const OTHER_COMMANDS_TITLE = "Other Commands";
export const CUSTOM_COMMANDS_TITLE = "Custom Commands";

export const HELP_WORKFLOW_GROUPS: readonly HelpWorkflowGroup[] = [
  {
    title: "Session",
    commands: ["status", "resume", "compact", "clear", "exit"],
  },
  {
    title: "Account",
    commands: ["login", "logout", "whoami", "account"],
  },
  {
    title: "Model / Provider",
    commands: ["model", "provider"],
  },
  {
    title: "Tools / MCP",
    commands: ["mcp", "hooks", "plugins", "skills"],
  },
  {
    title: "Agents / Tasks",
    commands: ["agents", "tasks"],
  },
  {
    title: "Permissions",
    commands: ["permissions", "plan"],
  },
  {
    title: "Project / Context",
    commands: ["config", "memory", "init", "output-style", "output-style:new", "context", "diff"],
  },
  {
    title: "Protocol",
    commands: ["claim", "delegate", "proof", "settle", "stake"],
  },
  {
    title: "Utility",
    commands: ["help"],
  },
];

const GROUP_INDEX = new Map(
  HELP_WORKFLOW_GROUPS.map((group, index) => [group.title, index] as const),
);

const GROUP_BY_COMMAND = new Map<string, string>(
  HELP_WORKFLOW_GROUPS.flatMap((group) =>
    group.commands.map((command) => [command, group.title] as const),
  ),
);

export function helpWorkflowTitleForCommand(
  command: HelpWorkflowCommand,
  builtInCommandNames?: ReadonlySet<string>,
): string {
  if (
    builtInCommandNames &&
    !matchesCommandNameSet(command, builtInCommandNames)
  ) {
    return CUSTOM_COMMANDS_TITLE;
  }

  return (
    commandGroupTitle(command.name) ??
    firstAliasGroupTitle(command.aliases) ??
    OTHER_COMMANDS_TITLE
  );
}

export function compareHelpWorkflowCommands(
  left: HelpWorkflowCommand,
  right: HelpWorkflowCommand,
): number {
  const leftTitle = helpWorkflowTitleForCommand(left);
  const rightTitle = helpWorkflowTitleForCommand(right);
  const groupDelta = groupOrder(leftTitle) - groupOrder(rightTitle);
  if (groupDelta !== 0) return groupDelta;
  return left.name.localeCompare(right.name);
}

function matchesCommandNameSet(
  command: HelpWorkflowCommand,
  names: ReadonlySet<string>,
): boolean {
  return (
    names.has(command.name) ||
    (command.aliases ?? []).some((alias) => names.has(alias))
  );
}

function commandGroupTitle(name: string): string | undefined {
  return GROUP_BY_COMMAND.get(name.toLowerCase());
}

function firstAliasGroupTitle(
  aliases: readonly string[] | undefined,
): string | undefined {
  for (const alias of aliases ?? []) {
    const title = commandGroupTitle(alias);
    if (title !== undefined) return title;
  }
  return undefined;
}

function groupOrder(title: string): number {
  if (title === OTHER_COMMANDS_TITLE) return HELP_WORKFLOW_GROUPS.length;
  if (title === CUSTOM_COMMANDS_TITLE) return HELP_WORKFLOW_GROUPS.length + 1;
  return GROUP_INDEX.get(title) ?? HELP_WORKFLOW_GROUPS.length;
}
