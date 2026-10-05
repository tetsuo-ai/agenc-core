import type { Command, CommandBase } from "../commands.js";

export function getCommandName(cmd: CommandBase): string {
  return cmd.userFacingName?.() ?? cmd.name;
}

export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true;
}

export function findCommand(
  commandName: string,
  commands: readonly Command[],
): Command | undefined {
  return commands.find(
    command =>
      command.name === commandName ||
      getCommandName(command) === commandName,
  ) ?? commands.find(
    command =>
      command.aliases?.includes(commandName),
  );
}

export function hasCommand(
  commandName: string,
  commands: readonly Command[],
): boolean {
  return findCommand(commandName, commands) !== undefined;
}

export function getCommand(
  commandName: string,
  commands: readonly Command[],
): Command {
  const command = findCommand(commandName, commands);
  if (!command) {
    throw new ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(command => {
          const name = getCommandName(command);
          return command.aliases
            ? `${name} (aliases: ${command.aliases.join(", ")})`
            : name;
        })
        .sort((a, b) => a.localeCompare(b))
        .join(", ")}`,
    );
  }
  return command;
}
