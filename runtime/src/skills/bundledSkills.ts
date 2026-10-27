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
  /**
   * `false` keeps the skill out of the skill listings the model and the user
   * see (the per-session listing, `/skills`, unknown-skill suggestions)
   * unless the operator turns it on in config; see
   * {@link isBundledSkillListed}. It stays loadable by exact name. Defaults to
   * listed.
   */
  listedByDefault?: boolean
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
// Names registered with `listedByDefault: false`.
const unlistedByDefaultSkills = new Set<string>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a bundled skill belongs in the skill listings for a session running
 * under `config`. A skill registered with `listedByDefault: false` is listed
 * only once the operator has turned the marketplace on (`[protocol] enabled =
 * true`, which project config cannot set). Listing is separate from loading:
 * the skill can always be loaded by its exact name, and a session with a
 * toolPolicy applies its own rule on top.
 */
export function isBundledSkillListed(name: string, config: unknown): boolean {
  if (!unlistedByDefaultSkills.has(name)) return true
  return isPlainRecord(config) &&
    isPlainRecord(config.protocol) &&
    config.protocol.enabled === true
}

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
  if (definition.listedByDefault === false) {
    unlistedByDefaultSkills.add(definition.name)
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
  unlistedByDefaultSkills.clear()
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
