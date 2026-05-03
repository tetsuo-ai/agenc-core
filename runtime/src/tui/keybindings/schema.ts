/**
 * Zod schema for keybindings.json configuration.
 * Used for validation and JSON schema generation.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../agenc/upstream/utils/lazySchema.js'
import {
  KEYBINDING_ACTION_NAMES,
  KEYBINDING_CONTEXT_NAMES,
} from './types.js'

/**
 * Valid context names where keybindings can be applied.
 */
export const KEYBINDING_CONTEXTS = KEYBINDING_CONTEXT_NAMES

/**
 * Human-readable descriptions for each keybinding context.
 */
export const KEYBINDING_CONTEXT_DESCRIPTIONS: Record<
  (typeof KEYBINDING_CONTEXTS)[number],
  string
> = {
  Global: 'Active everywhere, regardless of focus',
  Chat: 'When the chat input is focused',
  Autocomplete: 'When autocomplete menu is visible',
  Confirmation: 'When a confirmation/permission dialog is shown',
  Help: 'When the help overlay is open',
  Transcript: 'When viewing the transcript',
  HistorySearch: 'When searching command history (ctrl+r)',
  Task: 'When a task/agent is running in the foreground',
  ThemePicker: 'When the theme picker is open',
  Scroll: 'When a scrollable area is focused',
  Settings: 'When the settings menu is open',
  Tabs: 'When tab navigation is active',
  Attachments: 'When navigating image attachments in a select dialog',
  Footer: 'When footer indicators are focused',
  MessageSelector: 'When the message selector (rewind) is open',
  MessageActions: 'When message actions are focused',
  DiffDialog: 'When the diff dialog is open',
  ModelPicker: 'When the model picker is open',
  Select: 'When a select/list component is focused',
  Plugin: 'When the plugin dialog is open',
}

/**
 * All valid keybinding action identifiers.
 */
export const KEYBINDING_ACTIONS = KEYBINDING_ACTION_NAMES

/**
 * Schema for a single keybinding block.
 */
export const KeybindingBlockSchema = lazySchema(() =>
  z
    .object({
      context: z
        .enum(KEYBINDING_CONTEXTS)
        .describe(
          'UI context where these bindings apply. Global bindings work everywhere.',
        ),
      bindings: z
        .record(
          z
            .string()
            .describe('Keystroke pattern (e.g., "ctrl+k", "shift+tab")'),
          z
            .union([
              z.enum(KEYBINDING_ACTIONS),
              z
                .string()
                .regex(/^command:[a-zA-Z0-9:\-_]+$/)
                .describe(
                  'Command binding (e.g., "command:help", "command:compact"). Executes the slash command as if typed.',
                ),
              z.null().describe('Set to null to unbind a default shortcut'),
            ])
            .describe(
              'Action to trigger, command to invoke, or null to unbind',
            ),
        )
        .describe('Map of keystroke patterns to actions'),
    })
    .describe('A block of keybindings for a specific context'),
)

/**
 * Schema for the entire keybindings.json file.
 * Uses object wrapper format with optional $schema and $docs metadata.
 */
export const KeybindingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z
        .string()
        .optional()
        .describe('JSON Schema URL for editor validation'),
      $docs: z.string().optional().describe('Documentation URL'),
      bindings: z
        .array(KeybindingBlockSchema())
        .describe('Array of keybinding blocks by context'),
    })
    .describe(
      'AgenC keybindings configuration. Customize keyboard shortcuts by context.',
    ),
)

/**
 * TypeScript types derived from the schema.
 */
export type KeybindingsSchemaType = z.infer<
  ReturnType<typeof KeybindingsSchema>
>
