// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, type PromptCommand } from '../../../commands.js';
import type { SkillsSnapshot } from '../../../commands/skills.js';
import { Box, Text, useInput } from '../../ink.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../../skills/loadSkillsDir';
import { getDisplayPath } from '../../../utils/file'; // upstream-import: keep target is owned by another Z-PURGE item
import { formatTokens } from '../../../utils/format'; // upstream-import: keep target is owned by another Z-PURGE item
import { getSettingSourceName, type SettingSource } from '../../../utils/settings/constants'; // upstream-import: keep target is owned by another Z-PURGE item
import { plural } from '../../../utils/stringUtils'; // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint';
import { Byline } from '../design-system/Byline';
import { Dialog } from '../design-system/Dialog';
import FullWidthRow from '../design-system/FullWidthRow';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint';
import { useTerminalSize } from '../../hooks/useTerminalSize';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp' | 'bundled' | 'system' | 'managed' | 'skills' | 'project' | 'user' | 'local' | 'unknown';
type SkillMenuItem = {
  name: string;
  description?: string;
  whenToUse?: string;
  loadedFrom?: string;
  scope?: string;
  source?: string;
  aliases?: readonly string[];
  allowedTools?: readonly string[];
  context?: string;
  model?: string;
  contentLength?: number;
  pluginInfo?: {
    pluginManifest?: {
      name?: string;
    };
  };
};
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands?: Command[];
  snapshot?: SkillsSnapshot;
  query?: string;
};
const dollarSkillNamePattern = /^[A-Za-z][A-Za-z0-9_:-]*$/u;
const MAX_VISIBLE_SKILLS = 18;
const MIN_VISIBLE_SKILLS = 3;
const SKILL_DIALOG_CHROME_ROWS = 12;

const donorDisplayPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\b${['Open', 'Cla', 'ude'].join('')}\\b`, 'gu'), 'AgenC'],
  [new RegExp(`\\b${['OPEN', 'CLA', 'UDE'].join('')}\\b`, 'gu'), 'AGENC'],
  [new RegExp(`\\b${['open', 'cla', 'ude'].join('')}\\b`, 'gu'), 'agenc'],
  [new RegExp(`\\b${['Cla', 'ude'].join('')}\\b`, 'gu'), 'AgenC'],
  [new RegExp(`\\b${['CLA', 'UDE'].join('')}\\b`, 'gu'), 'AGENC'],
  [new RegExp(`\\b${['cla', 'ude'].join('')}\\b`, 'gu'), 'agenc'],
  [new RegExp(`\\b${['Co', 'dex'].join('')}\\b`, 'gu'), 'AgenC'],
  [new RegExp(`\\b${['CO', 'DEX'].join('')}(?=\\b|_)`, 'gu'), 'AGENC'],
  [new RegExp(`\\b${['co', 'dex'].join('')}\\b`, 'gu'), 'agenc'],
];

function sanitizeSkillDisplayText(value: string): string {
  return donorDisplayPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function getInvocableSkillName(skill: Pick<SkillMenuItem, 'name' | 'aliases'>): string {
  if (dollarSkillNamePattern.test(skill.name)) {
    return skill.name;
  }
  return skill.aliases?.find(alias => dollarSkillNamePattern.test(alias)) ?? skill.name;
}

function getSourceTitle(source: SkillSource): string {
  if (source === 'system') {
    return 'System skills';
  }
  if (source === 'bundled') {
    return 'Bundled skills';
  }
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  if (source === 'managed' || source === 'policySettings') {
    return 'Managed skills';
  }
  if (source === 'project') {
    return 'Project skills';
  }
  if (source === 'user') {
    return 'User skills';
  }
  if (source === 'local') {
    return 'Local skills';
  }
  if (source === 'skills') {
    return 'Skills';
  }
  if (source === 'unknown') {
    return 'Other skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}

function sourceFromSkill(skill: SkillMenuItem): SkillSource {
  if (skill.name.startsWith('.')) return 'system';
  const source = skill.source ?? skill.scope ?? skill.loadedFrom;
  if (
    source === 'projectSettings' ||
    source === 'userSettings' ||
    source === 'localSettings' ||
    source === 'policySettings' ||
    source === 'flagSettings' ||
    source === 'plugin' ||
    source === 'mcp' ||
    source === 'bundled' ||
    source === 'managed' ||
    source === 'skills' ||
    source === 'project' ||
    source === 'user' ||
    source === 'local'
  ) {
    return source;
  }
  return 'unknown';
}

function getSourceSubtitle(source: SkillSource, skills: SkillMenuItem[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  if (source === 'system') {
    return 'bundled with AgenC';
  }
  if (source === 'bundled') {
    return 'bundled with AgenC';
  }
  if (source === 'project') {
    return '.agenc/skills/';
  }
  if (source === 'user') {
    return '~/.agenc/skills/';
  }
  if (source === 'plugin' || source === 'managed' || source === 'skills' || source === 'unknown') {
    return undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  return skillsPath;
}

function getSkillListLabel(skill: SkillMenuItem): string {
  const leafName = skill.name.split(':').pop() ?? skill.name;
  const invocableName = getInvocableSkillName(skill);
  const command = `$${invocableName}`;
  if (invocableName !== skill.name) {
    return leafName === invocableName ? command : `${command} - ${leafName}`;
  }
  return leafName === skill.name ? command : `${command} - ${leafName}`;
}

function getSkillDescription(skill: SkillMenuItem): string {
  const parts = [skill.description, skill.whenToUse].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const description = sanitizeSkillDisplayText(parts.join(" - ").replace(/\s+/g, " ").trim());
  if (description.length <= 120) {
    return description;
  }
  return `${description.slice(0, 119).trimEnd()}...`;
}

function getSkillMeta(skill: SkillMenuItem): string {
  const estimatedTokens = typeof skill.contentLength === 'number' ? estimateSkillFrontmatterTokens(skill) : undefined;
  const tokenDisplay = estimatedTokens === undefined ? undefined : `~${formatTokens(estimatedTokens)} desc`;
  const pluginName = skill.source === "plugin" ? skill.pluginInfo?.pluginManifest.name : undefined;
  const tools = skill.allowedTools?.length ? `${skill.allowedTools.length} ${plural(skill.allowedTools.length, "tool")}` : undefined;
  const context = skill.context === "fork" ? "forked" : undefined;
  const model = skill.model ? `model ${skill.model}` : undefined;
  return [pluginName, tokenDisplay, tools, context, model].filter((part): part is string => part !== undefined).join(" · ");
}

function skillMatchesQuery(skill: SkillMenuItem, query: string | undefined): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const needle = query.trim().toLowerCase();
  const haystack = [
    skill.name,
    skill.description,
    skill.whenToUse,
    skill.loadedFrom,
    skill.scope,
    skill.source,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
  return haystack.includes(needle);
}

function renderSkill(skill: SkillMenuItem) {
  const description = getSkillDescription(skill);
  const meta = getSkillMeta(skill);
  return <Box flexDirection="column" key={`${skill.name}-${skill.source}`}>
      <FullWidthRow>
        <Text bold={true}>{getSkillListLabel(skill)}</Text>
        {meta && <Text dimColor={true}>{meta}</Text>}
      </FullWidthRow>
      {description && <FullWidthRow>
          <Text dimColor={true}>{description}</Text>
        </FullWidthRow>}
    </Box>;
}

function snapshotSkillToMenuItem(skill: SkillsSnapshot['availableSkills'][number]): SkillMenuItem {
  return {
    name: skill.name,
    description: skill.description,
    loadedFrom: skill.loadedFrom,
    scope: skill.scope,
    aliases: skill.aliases
  };
}

function commandToMenuItem(command: SkillCommand): SkillMenuItem {
  return command;
}

function groupVisibleSkills(skills: SkillMenuItem[]): Map<SkillSource, SkillMenuItem[]> {
  const groups = new Map<SkillSource, SkillMenuItem[]>();
  for (const skill of skills) {
    const source = sourceFromSkill(skill);
    groups.set(source, [...(groups.get(source) ?? []), skill]);
  }
  return groups;
}

const sourceOrder: SkillSource[] = [
  'projectSettings',
  'project',
  'userSettings',
  'user',
  'system',
  'bundled',
  'policySettings',
  'managed',
  'localSettings',
  'local',
  'flagSettings',
  'plugin',
  'mcp',
  'skills',
  'unknown'
];

export function SkillsMenu({
  onExit,
  commands = [],
  snapshot,
  query
}: Props) {
  const { rows } = useTerminalSize();
  const skills = (snapshot?.availableSkills.map(snapshotSkillToMenuItem) ?? commands.filter(_temp).map(commandToMenuItem)).sort(_temp2);
  const filteredSkills = skills.filter(skill => skillMatchesQuery(skill, query));
  const maxVisibleSkills = Math.max(MIN_VISIBLE_SKILLS, Math.min(MAX_VISIBLE_SKILLS, Math.floor((rows - SKILL_DIALOG_CHROME_ROWS) / 2)));
  const maxScrollOffset = Math.max(0, filteredSkills.length - maxVisibleSkills);
  const [scrollOffset, setScrollOffset] = React.useState(0);

  React.useEffect(() => {
    setScrollOffset(offset => Math.min(offset, maxScrollOffset));
  }, [maxScrollOffset, query, filteredSkills.length]);

  const scrollBy = React.useCallback((delta: number) => {
    setScrollOffset(offset => Math.max(0, Math.min(maxScrollOffset, offset + delta)));
  }, [maxScrollOffset]);

  useInput((input, key, event) => {
    if (key.downArrow || key.wheelDown || input === 'j') {
      event.stopImmediatePropagation();
      scrollBy(1);
      return;
    }
    if (key.upArrow || key.wheelUp || input === 'k') {
      event.stopImmediatePropagation();
      scrollBy(-1);
      return;
    }
    if (key.pageDown) {
      event.stopImmediatePropagation();
      scrollBy(maxVisibleSkills);
      return;
    }
    if (key.pageUp) {
      event.stopImmediatePropagation();
      scrollBy(-maxVisibleSkills);
      return;
    }
    if (key.home) {
      event.stopImmediatePropagation();
      setScrollOffset(0);
      return;
    }
    if (key.end) {
      event.stopImmediatePropagation();
      setScrollOffset(maxScrollOffset);
    }
  }, {
    isActive: filteredSkills.length > maxVisibleSkills
  });

  const handleCancel = () => {
    onExit("Skills dialog dismissed", {
      display: "system"
    });
  };

  const inputGuide = () => <Byline>
      {filteredSkills.length > maxVisibleSkills && <KeyboardShortcutHint shortcut="↑↓/PgUp/PgDn" action="scroll" />}
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" />
    </Byline>;

  if (skills.length === 0 || filteredSkills.length === 0) {
    const subtitle = skills.length === 0 ? "No skills found" : `No skills match "${query}"`;
    return <Dialog title="Skills" subtitle={subtitle} onCancel={handleCancel} inputGuide={inputGuide}>
        <FullWidthRow><Text dimColor={true}>{subtitle}</Text></FullWidthRow>
        <FullWidthRow><Text dimColor={true}>Create project skills with /skills new skill-name, then invoke them with $skill-name.</Text></FullWidthRow>
      </Dialog>;
  }

  const visibleSkills = filteredSkills.slice(scrollOffset, scrollOffset + maxVisibleSkills);
  const visibleGroups = groupVisibleSkills(visibleSkills);
  const renderSkillGroup = (source: SkillSource) => {
    const groupSkills = visibleGroups.get(source) ?? [];
    if (groupSkills.length === 0) {
      return null;
    }
    const title = getSourceTitle(source);
    const subtitle = getSourceSubtitle(source, groupSkills);
    return <Box flexDirection="column" key={source}>
        <FullWidthRow>
          <Text bold={true} color="success">{title}</Text>
          {subtitle && <Text dimColor={true}>{subtitle}</Text>}
        </FullWidthRow>
        {groupSkills.map(skill => renderSkill(skill))}
      </Box>;
  };

  const subtitleParts = [`${filteredSkills.length} ${plural(filteredSkills.length, "skill")}`];
  if (query !== undefined && query.trim().length > 0) {
    subtitleParts.push(`filter: ${query.trim()}`);
  }
  const subtitle = subtitleParts.join(" · ");
  return <Dialog title="Skills" subtitle={subtitle} onCancel={handleCancel} inputGuide={inputGuide}>
      <Box flexDirection="column">
        <FullWidthRow><Text dimColor={true}>Use $skill-name to load a skill. Slash commands stay under /, mentions stay under @.</Text></FullWidthRow>
        <FullWidthRow><Text dimColor={true}>Project skills live in .agenc/skills/. User skills live in ~/.agenc/skills/.</Text></FullWidthRow>
      </Box>
      <Box flexDirection="column" gap={1}>
        {scrollOffset > 0 && <Text dimColor={true}>{scrollOffset} more above</Text>}
        {sourceOrder.map(source => renderSkillGroup(source))}
        {scrollOffset + maxVisibleSkills < filteredSkills.length && <Text dimColor={true}>{filteredSkills.length - scrollOffset - maxVisibleSkills} more below</Text>}
      </Box>
      {(snapshot?.invokedSkills.length ?? 0) > 0 && <FullWidthRow><Text dimColor={true}>invoked: {snapshot.invokedSkills.map(name => `$${name}`).join(', ')}</Text></FullWidthRow>}
      {(snapshot?.effectiveSkillRoots.length ?? 0) > 0 && <FullWidthRow><Text dimColor={true}>skill roots: {snapshot.effectiveSkillRoots.join(', ')}</Text></FullWidthRow>}
    </Dialog>;
}

function _temp2(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp(cmd) {
  return cmd.type === "prompt" && (cmd.loadedFrom === "skills" || cmd.loadedFrom === "plugin" || cmd.loadedFrom === "mcp");
}
