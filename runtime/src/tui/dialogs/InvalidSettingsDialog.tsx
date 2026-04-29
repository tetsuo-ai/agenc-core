import React, { useCallback } from 'react'
import { Box, Text } from '../ink-public.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../design-system/CustomSelect/index.js'

/**
 * Shape of a settings validation error. Mirrors the upstream
 * `ValidationError` contract loosely so callers from any settings loader can
 * pass entries through without coupling to a specific schema validator.
 */
export type SettingsValidationError = {
  /** Source file the error originated from. Used to group errors. */
  file?: string
  /** Dot-notated path of the offending key. */
  path?: string
  /** Human-readable error description. */
  message: string
  /** Optional hint shown beneath the grouped errors. */
  suggestion?: string
  /** Optional doc reference. */
  docLink?: string
}

type Props = {
  settingsErrors: SettingsValidationError[]
  onContinue: () => void
  onExit: () => void
}

function ErrorsList({
  errors,
}: {
  errors: SettingsValidationError[]
}): React.ReactElement | null {
  if (errors.length === 0) return null
  // Group by file so multi-file validation reports stay readable.
  const byFile = new Map<string, SettingsValidationError[]>()
  for (const err of errors) {
    const file = err.file ?? '(file not specified)'
    const list = byFile.get(file) ?? []
    list.push(err)
    byFile.set(file, list)
  }
  const sortedFiles = Array.from(byFile.keys()).sort()
  return (
    <Box flexDirection="column">
      {sortedFiles.map(file => {
        const fileErrors = byFile.get(file) ?? []
        return (
          <Box key={file} flexDirection="column">
            <Text>{file}</Text>
            <Box flexDirection="column" marginLeft={1}>
              {fileErrors.map((err, i) => (
                <Text key={`${err.path ?? ''}-${i}`} dimColor={true}>
                  {err.path ? `${err.path}: ` : ''}
                  {err.message}
                </Text>
              ))}
            </Box>
            {fileErrors.some(e => e.suggestion || e.docLink) && (
              <Box flexDirection="column" marginTop={1}>
                {fileErrors.map((err, i) =>
                  err.suggestion || err.docLink ? (
                    <Box
                      key={`hint-${i}`}
                      flexDirection="column"
                      marginBottom={1}
                    >
                      {err.suggestion && (
                        <Text dimColor={true} wrap="wrap">
                          {err.suggestion}
                        </Text>
                      )}
                      {err.docLink && (
                        <Text dimColor={true} wrap="wrap">
                          Learn more: {err.docLink}
                        </Text>
                      )}
                    </Box>
                  ) : null,
                )}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Dialog shown when settings files have validation errors. The user must
 * choose to continue (skipping invalid files entirely) or exit to fix them.
 */
export function InvalidSettingsDialog({
  settingsErrors,
  onContinue,
  onExit,
}: Props): React.ReactElement {
  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'exit') {
        onExit()
      } else {
        onContinue()
      }
    },
    [onContinue, onExit],
  )

  const options = [
    { label: 'Exit and fix manually', value: 'exit' },
    { label: 'Continue without these settings', value: 'continue' },
  ]

  return (
    <Dialog title="Settings Error" onCancel={onExit} color="warning">
      <ErrorsList errors={settingsErrors} />
      <Text dimColor={true}>
        Files with errors are skipped entirely, not just the invalid settings.
      </Text>
      <Select options={options} onChange={handleSelect} />
    </Dialog>
  )
}
