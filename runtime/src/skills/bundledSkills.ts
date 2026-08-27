import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../tools/Tool.js'
import type { Command } from '../types/command.js'
import type { HooksSettings } from '../schemas/hooks.js'
import {
  extractBundledSkillFiles,
  getBundledSkillDirectory,
} from './bundled-extraction-registry.js'
import { getCurrentBundledSkillExtractionRoot } from './bundled-root-authority.js'
// Pure data (type-only back-reference to this module — no runtime cycle).
import { AGENC_MARKETPLACE_KIT_INSTALLER_SKILL } from './bundled/agencMarketplaceKitInstaller.js'
import { BROWSER_AUTOMATION_SKILL } from './bundled/browserAutomation.js'
import { IOT_BUILDER_SKILL } from './bundled/iotBuilder.js'

/**
 * Definition for a bundled skill that ships with the CLI.
 * These are registered programmatically at startup.
 */
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  /**
   * Additional reference files to extract to disk on first invocation.
   * Keys are relative paths (forward slashes, no `..`), values are content.
   * When set, the skill prompt is prefixed with a "Base directory for this
   * skill: <dir>" line so the model can Read/Grep these files on demand —
   * same contract as disk-based skills.
   */
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

// Internal registry for bundled skills
const bundledSkills: Command[] = []

/**
 * Register a bundled skill that will be available to the model.
 * Call this at module initialization or in an init function.
 *
 * Bundled skills are compiled into the CLI binary and available to all users.
 * They follow the same pattern as registerPostSamplingHook() for internal features.
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition

  const hasFiles = files !== undefined && Object.keys(files).length > 0
  let getPromptForCommand = definition.getPromptForCommand

  if (hasFiles) {
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      const root = getCurrentBundledSkillExtractionRoot()
      const extractedDir = await extractBundledSkillFiles(
        root,
        definition.name,
        files,
      )
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0, // Not applicable for bundled skills
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    // Resolve lazily so the path follows the active session's captured temp
    // authority instead of the import-time process context.
    get skillRoot(): string | undefined {
      return hasFiles ? getBundledSkillExtractDir(definition.name) : undefined
    },
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled,
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand,
  }
  bundledSkills.push(command)
}

/**
 * Get all registered bundled skills.
 * Returns a copy to prevent external mutation.
 */
export function getBundledSkills(): Command[] {
  return [...bundledSkills]
}

/**
 * Clear bundled skills registry (for testing).
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

/**
 * Deterministic extraction directory for a bundled skill's reference files.
 */
export function getBundledSkillExtractDir(skillName: string): string {
  return getBundledSkillDirectory(
    getCurrentBundledSkillExtractionRoot(),
    skillName,
  )
}

function prependBaseDir(
  blocks: ContentBlockParam[],
  baseDir: string,
): ContentBlockParam[] {
  const prefix = `Base directory for this skill: ${baseDir}\n\n`
  if (blocks.length > 0 && blocks[0]!.type === 'text') {
    return [
      { type: 'text', text: prefix + blocks[0]!.text },
      ...blocks.slice(1),
    ]
  }
  return [{ type: 'text', text: prefix }, ...blocks]
}

// Register in-tree bundled skills once, at module load.
registerBundledSkill(BROWSER_AUTOMATION_SKILL)
registerBundledSkill(AGENC_MARKETPLACE_KIT_INSTALLER_SKILL)
registerBundledSkill(IOT_BUILDER_SKILL)
