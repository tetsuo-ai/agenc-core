// @ts-nocheck
import * as React from 'react';
import {
  getCommandName,
  type Command,
  type LocalJSXCommandContext,
} from '../../commands.js';
import { SkillsMenu } from '../../components/skills/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

const ROUTABLE_SKILL_SOURCES = new Set([
  'skills',
  'commands_DEPRECATED',
  'plugin',
  'mcp',
  'bundled',
]);

function isRoutableSkillCommand(command: Command): boolean {
  return command.type === 'prompt' && ROUTABLE_SKILL_SOURCES.has(command.loadedFrom ?? '');
}

function normalizeLookupToken(value: string | undefined): string {
  return String(value ?? '').trim().replace(/^\/+/, '').toLowerCase();
}

function buildSkillLookupTokens(command: Command): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    const normalized = normalizeLookupToken(value);
    if (normalized) {
      values.add(normalized);
    }
  };

  add(command.name);
  add(getCommandName(command));

  for (const alias of command.aliases ?? []) {
    add(alias);
  }

  const commandLeaf = command.name.split(':').pop();
  if (commandLeaf && commandLeaf !== command.name) {
    add(commandLeaf);
  }

  const displayLeaf = getCommandName(command).split(':').pop();
  if (displayLeaf && displayLeaf !== getCommandName(command)) {
    add(displayLeaf);
  }

  return [...values];
}

function resolveSkillRedirect(commands: Command[], args: string): string | null {
  const trimmed = String(args ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const [requestedSkill, ...rest] = trimmed.split(/\s+/);
  const lookup = normalizeLookupToken(requestedSkill);
  if (!lookup) {
    return null;
  }

  const matches = commands
    .filter(isRoutableSkillCommand)
    .filter((command) => buildSkillLookupTokens(command).includes(lookup));

  if (matches.length !== 1) {
    return null;
  }

  const forwardedArgs = rest.join(' ').trim();
  const slashCommand = `/${getCommandName(matches[0]).replace(/^\/+/, '')}`;
  return forwardedArgs ? `${slashCommand} ${forwardedArgs}` : slashCommand;
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args = '',
): Promise<React.ReactNode> {
  const redirect = resolveSkillRedirect(context.options.commands, args);
  if (redirect) {
    onDone(undefined, {
      display: 'skip',
      nextInput: redirect,
      submitNextInput: true,
    });
    return null;
  }

  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
