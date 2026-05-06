import * as React from 'react';
import type { LocalJSXCommandContext } from '../../../../commands.js';
import { SkillsMenu } from '../../../../tui/components/skills/SkillsMenu';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
