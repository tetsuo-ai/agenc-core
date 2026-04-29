/**
 * Per-tool permission dialog body for the Skill tool.
 *
 * Ported from upstream. Skill invocations are conceptually a "named
 * subroutine call" — the dialog surfaces the skill name and any inline
 * description, and offers session-scope and prefix-scope (always allow
 * skills that share this command prefix) options in addition to the
 * one-shot allow.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { PermissionRequestProps } from './PermissionRequest.js'

const MAX_PREVIEW_LINES = 6

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function truncate(value: string, maxLines: number): string {
  if (!value) return ''
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n…`
}

function extractSkill(input: Record<string, unknown>): {
  readonly name: string
  readonly prompt: string
} {
  const name = coerceString(input.skill ?? input.name ?? input.id)
  const prompt = coerceString(input.prompt ?? input.message ?? input.input)
  return { name, prompt }
}

function commandPrefix(skill: string): string {
  if (!skill) return ''
  const space = skill.indexOf(' ')
  return space > 0 ? skill.slice(0, space) : skill
}

type SelectValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no'

export const PermissionRequestSkill: React.FC<PermissionRequestProps> = ({
  subject,
  onResolve,
  onCancel,
}) => {
  const skill = useMemo(
    () => extractSkill(subject.toolInput),
    [subject.toolInput],
  )
  const prefix = useMemo(() => commandPrefix(skill.name), [skill.name])

  const handleCancel = useCallback(() => {
    onResolve({ behavior: 'abort' })
    onCancel?.()
  }, [onCancel, onResolve])

  const handleChange = useCallback(
    (value: SelectValue) => {
      switch (value) {
        case 'yes':
          onResolve({ behavior: 'allow' })
          return
        case 'yes-exact':
        case 'yes-prefix':
          onResolve({ behavior: 'allow-session', addRule: true })
          return
        case 'no':
          onResolve({ behavior: 'deny' })
          return
      }
    },
    [onResolve],
  )

  const options = useMemo(() => {
    const entries: Array<{ value: SelectValue; label: React.ReactNode }> = [
      { value: 'yes', label: 'Yes' },
    ]
    if (skill.name) {
      entries.push({
        value: 'yes-exact',
        label: (
          <Text>
            Yes, and don&apos;t ask again for{' '}
            <Text bold={true}>{skill.name}</Text>
          </Text>
        ),
      })
      if (prefix && prefix !== skill.name) {
        entries.push({
          value: 'yes-prefix',
          label: (
            <Text>
              Yes, and don&apos;t ask again for{' '}
              <Text bold={true}>{`${prefix}:*`}</Text> commands
            </Text>
          ),
        })
      }
    }
    entries.push({
      value: 'no',
      label: 'No, tell AgenC what to do differently',
    })
    return entries
  }, [prefix, skill.name])

  return (
    <Dialog
      title={skill.name ? `Use skill "${skill.name}"?` : 'Use skill'}
      onCancel={handleCancel}
    >
      <Text>AgenC may use instructions, code, or files from this Skill.</Text>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor={true}>{`skill · ${skill.name || '(unknown)'}`}</Text>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text>{truncate(skill.prompt, MAX_PREVIEW_LINES) || '(no prompt)'}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Select<SelectValue>
          options={options}
          onChange={handleChange}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default PermissionRequestSkill
