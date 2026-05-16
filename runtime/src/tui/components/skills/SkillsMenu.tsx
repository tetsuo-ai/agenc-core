// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, type PromptCommand } from '../../../commands.js';
import { Box, Text } from '../../ink.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../../skills/loadSkillsDir';
import { getDisplayPath } from '../../../utils/file'; // upstream-import: keep target is owned by another Z-PURGE item
import { formatTokens } from '../../../utils/format'; // upstream-import: keep target is owned by another Z-PURGE item
import { getSettingSourceName, type SettingSource } from '../../../utils/settings/constants'; // upstream-import: keep target is owned by another Z-PURGE item
import { plural } from '../../../utils/stringUtils'; // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint';
import { Dialog } from '../design-system/Dialog';
import FullWidthRow from '../design-system/FullWidthRow';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp';
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};
const dollarSkillNamePattern = /^[A-Za-z][A-Za-z0-9_:-]*$/u;

function getInvocableSkillName(skill: SkillCommand): string {
  if (dollarSkillNamePattern.test(skill.name)) {
    return skill.name;
  }
  return skill.aliases?.find(alias => dollarSkillNamePattern.test(alias)) ?? skill.name;
}

function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}
function getSourceSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  return skillsPath;
}
function getSkillListLabel(skill: SkillCommand): string {
  const leafName = skill.name.split(':').pop() ?? skill.name;
  const invocableName = getInvocableSkillName(skill);
  const command = `$${invocableName}`;
  if (invocableName !== skill.name) {
    return leafName === invocableName ? command : `${command} - ${leafName}`;
  }
  return leafName === skill.name ? command : `${command} - ${leafName}`;
}

function getSkillDescription(skill: SkillCommand): string {
  const parts = [skill.description, skill.whenToUse].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const description = parts.join(" - ").replace(/\s+/g, " ").trim();
  if (description.length <= 120) {
    return description;
  }
  return `${description.slice(0, 119).trimEnd()}...`;
}

function getSkillMeta(skill: SkillCommand): string {
  const estimatedTokens = estimateSkillFrontmatterTokens(skill);
  const tokenDisplay = `~${formatTokens(estimatedTokens)} desc`;
  const pluginName = skill.source === "plugin" ? skill.pluginInfo?.pluginManifest.name : undefined;
  const tools = skill.allowedTools?.length ? `${skill.allowedTools.length} ${plural(skill.allowedTools.length, "tool")}` : undefined;
  const context = skill.context === "fork" ? "forked" : undefined;
  const model = skill.model ? `model ${skill.model}` : undefined;
  return [pluginName, tokenDisplay, tools, context, model].filter((part): part is string => part !== undefined).join(" · ");
}

function renderSkill(skill: SkillCommand) {
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

export function SkillsMenu({
  onExit,
  commands
}: Props) {
  const skills = commands.filter(_temp);
  const skillsBySource: Record<SkillSource, SkillCommand[]> = {
    policySettings: [],
    userSettings: [],
    projectSettings: [],
    localSettings: [],
    flagSettings: [],
    plugin: [],
    mcp: []
  };
  for (const skill of skills) {
    const source = skill.source as SkillSource;
    if (source in skillsBySource) {
      skillsBySource[source].push(skill);
    }
  }
  for (const group of Object.values(skillsBySource)) {
    group.sort(_temp2);
  }

  const handleCancel = () => {
    onExit("Skills dialog dismissed", {
      display: "system"
    });
  };

  const closeHint = <FullWidthRow>
      <Text dimColor={true} italic={true}>
        <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" />
      </Text>
    </FullWidthRow>;

  if (skills.length === 0) {
    return <Dialog title="Skills" subtitle="No skills found" onCancel={handleCancel} hideInputGuide={true}>
        <FullWidthRow><Text dimColor={true}>Create project skills in .agenc/skills/ or user skills in ~/.agenc/skills/.</Text></FullWidthRow>
        <FullWidthRow><Text dimColor={true}>Each skill needs a SKILL.md file with name and description frontmatter.</Text></FullWidthRow>
        {closeHint}
      </Dialog>;
  }

  const renderSkillGroup = (source: SkillSource) => {
    const groupSkills = skillsBySource[source];
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

  const subtitle = `${skills.length} ${plural(skills.length, "skill")}`;
  return <Dialog title="Skills" subtitle={subtitle} onCancel={handleCancel} hideInputGuide={true}>
      <Box flexDirection="column">
        <FullWidthRow><Text dimColor={true}>Use $skill-name to load a skill. Slash commands stay under /, mentions stay under @.</Text></FullWidthRow>
        <FullWidthRow><Text dimColor={true}>Project skills live in .agenc/skills/. User skills live in ~/.agenc/skills/.</Text></FullWidthRow>
      </Box>
      <Box flexDirection="column" gap={1}>
        {renderSkillGroup("projectSettings")}
        {renderSkillGroup("userSettings")}
        {renderSkillGroup("policySettings")}
        {renderSkillGroup("localSettings")}
        {renderSkillGroup("flagSettings")}
        {renderSkillGroup("plugin")}
        {renderSkillGroup("mcp")}
      </Box>
      {closeHint}
    </Dialog>;
}

function _temp2(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp(cmd) {
  return cmd.type === "prompt" && (cmd.loadedFrom === "skills" || cmd.loadedFrom === "plugin" || cmd.loadedFrom === "mcp");
}
