import { getSessionId } from '../bootstrap/state.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Command, PromptCommand } from '../types/command.js'
import {
  parseArgumentNames,
  substituteArguments,
} from '../tui/slash/argument-substitution.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../utils/effort.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  type FrontmatterShell,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
} from '../utils/frontmatterParser.js'
import {
  extractDescriptionFromMarkdown,
  parseSlashCommandToolsFromFrontmatter,
} from '../utils/markdownConfigLoader.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { HooksSchema, type HooksSettings } from '../schemas/hooks.js'
import { registerMCPSkillBuilders } from './mcpSkillBuilders.js'
import { frameUntrustedMcpSkillContent } from './untrustedMcpSkillFraming.js'
import {
  frameRepositorySkillGuidance,
  isRepositoryControlledSkillSource,
} from './repository-skill-boundary.js'

export type LoadedFrom =
  | 'skills'
  | 'plugin'
  | 'managed'
  | 'bundled'
  | 'mcp'

function parseSkillModelFrontmatter(
  value: unknown,
  skillName: string,
): ReturnType<typeof parseUserSpecifiedModel> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    logForDebugging(
      `Skill ${skillName} has invalid model frontmatter; expected a string`,
      { level: 'warn' },
    )
    return undefined
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.toLowerCase() === 'inherit') {
    return undefined
  }
  return parseUserSpecifiedModel(normalized)
}

function parseSkillShellFrontmatter(
  value: unknown,
  skillName: string,
): FrontmatterShell | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    logForDebugging(
      `Skill ${skillName} has invalid shell frontmatter; expected a string`,
      { level: 'warn' },
    )
    return undefined
  }
  return parseShellFrontmatter(value, skillName)
}

/**
 * Estimates token count for a skill based on frontmatter only
 * (name, description, whenToUse) since full content is only loaded on invocation.
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatterText = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  return roughTokenCountEstimation(frontmatterText)
}

/**
 * Parse and validate hooks from frontmatter.
 * Returns undefined if hooks are not defined or invalid.
 */
function parseHooksFromFrontmatter(
  frontmatter: FrontmatterData,
  skillName: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in skill '${skillName}': ${result.error.message}`,
    )
    return undefined
  }

  return result.data
}

/**
 * Parses all skill frontmatter fields that are shared between file-based and
 * MCP skill loading. Caller supplies the resolved skill name and the
 * source/loadedFrom/baseDir/paths fields separately.
 */
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
} {
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description,
    resolvedName,
  )
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel)

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])

  const model = parseSkillModelFrontmatter(frontmatter.model, resolvedName)

  const effortRaw = frontmatter['effort']
  const effort =
    effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined
  if (effortRaw !== undefined && effort === undefined) {
    logForDebugging(
      `Skill ${resolvedName} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
    )
  }

  return {
    displayName:
      frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    allowedTools: parseSlashCommandToolsFromFrontmatter(
      frontmatter['allowed-tools'],
    ),
    argumentHint:
      frontmatter['argument-hint'] != null
        ? String(frontmatter['argument-hint'])
        : undefined,
    argumentNames: parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    ),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(
      frontmatter['disable-model-invocation'],
    ),
    userInvocable,
    hooks: parseHooksFromFrontmatter(frontmatter, resolvedName),
    executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: frontmatter.agent as string | undefined,
    effort,
    shell: parseSkillShellFrontmatter(frontmatter.shell, resolvedName),
  }
}

/**
 * Creates a skill command from parsed data
 */
export function createSkillCommand({
  skillName,
  displayName,
  description,
  hasUserSpecifiedDescription,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  hooks,
  executionContext,
  agent,
  paths,
  effort,
  shell,
}: {
  skillName: string
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  markdownContent: string
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  source: PromptCommand['source']
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  hooks: HooksSettings | undefined
  executionContext: 'inline' | 'fork' | undefined
  agent: string | undefined
  paths: string[] | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
}): Command {
  const repositoryControlled = isRepositoryControlledSkillSource(source)
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools: repositoryControlled ? [] : allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model: repositoryControlled ? undefined : model,
    disableModelInvocation,
    userInvocable,
    context: repositoryControlled ? undefined : executionContext,
    agent: repositoryControlled ? undefined : agent,
    effort: repositoryControlled ? undefined : effort,
    paths,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    userFacingName(): string {
      return displayName || skillName
    },
    source,
    loadedFrom,
    hooks: repositoryControlled ? undefined : hooks,
    skillRoot: baseDir,
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      finalContent = substituteArguments(
        finalContent,
        args,
        true,
        argumentNames,
      )

      // Replace ${AGENC_SKILL_DIR} with the skill's own directory so bash
      // injection (!`...`) can reference bundled scripts. Normalize backslashes
      // to forward slashes on Windows so shell commands don't treat them as escapes.
      if (baseDir) {
        const skillDir =
          process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
        finalContent = finalContent.replace(/\$\{AGENC_SKILL_DIR\}/g, skillDir)
      }

      // Replace ${AGENC_SESSION_ID} with the current session ID
      finalContent = finalContent.replace(
        /\$\{AGENC_SESSION_ID\}/g,
        getSessionId(),
      )

      // Security: MCP skills are remote and untrusted — never execute inline
      // shell commands (!`…` / ```! … ```) from their markdown body.
      // ${AGENC_SKILL_DIR} is meaningless for MCP skills anyway.
      if (loadedFrom === 'mcp') {
        finalContent = frameUntrustedMcpSkillContent(skillName, finalContent)
      } else if (repositoryControlled) {
        // Repository markdown is guidance-only. Inline shell syntax remains
        // literal model context and never reaches the shell executor.
        finalContent = frameRepositorySkillGuidance(finalContent)
      } else {
        const { executeShellCommandsInPrompt } = await import(
          '../utils/promptShellExecution.js'
        )
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          {
            ...toolUseContext,
            getAppState() {
              const appState = toolUseContext.getAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: allowedTools,
                  },
                },
              }
            },
          },
          `/${skillName}`,
          shell,
        )
      }

      return [{
        type: 'text',
        text: finalContent,
      }]
    },
  } satisfies Command
}

// Expose createSkillCommand + parseSkillFrontmatterFields to MCP skill
// discovery via a leaf registry module. See mcpSkillBuilders.ts for why this
// indirection exists (a literal dynamic import from mcpSkills.ts fans a single
// edge out into many cycle violations; a variable-specifier dynamic import
// passes dep-cruiser but fails to resolve in Bun-bundled binaries at runtime).
// eslint-disable-next-line custom-rules/no-top-level-side-effects -- write-once registration, idempotent
registerMCPSkillBuilders({
  createSkillCommand,
  parseSkillFrontmatterFields,
})
