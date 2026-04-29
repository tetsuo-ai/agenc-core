import React, { useCallback } from 'react'
import { Text } from '../ink-public.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../design-system/CustomSelect/index.js'

type Props = {
  /**
   * The last few characters of the detected API key. Only the truncated
   * tail is shown — the full key is intentionally never rendered.
   */
  customApiKeyTruncated: string
  /**
   * Called with `true` when the user approves the key, `false` when they
   * reject it (or cancel). The caller is responsible for persisting the
   * decision (e.g. into AgenC config) and routing the runtime accordingly.
   */
  onDone: (approved: boolean) => void
}

/**
 * Dialog shown the first time AgenC detects a custom Anthropic API key in
 * the environment. Asks the user whether to use it. Defaults to "no" to
 * avoid silently sending traffic through an unexpected key.
 *
 * The full key value is NEVER displayed; only the trailing characters are
 * shown for identification.
 */
export function ApproveApiKey({
  customApiKeyTruncated,
  onDone,
}: Props): React.ReactElement {
  const onChange = useCallback(
    (value: 'yes' | 'no') => {
      onDone(value === 'yes')
    },
    [onDone],
  )

  const onCancel = useCallback(() => onChange('no'), [onChange])

  const options = [
    { label: 'Yes', value: 'yes' as const },
    {
      label: (
        <Text>
          No (<Text bold={true}>recommended</Text>)
        </Text>
      ),
      value: 'no' as const,
    },
  ]

  return (
    <Dialog
      title="Detected a custom API key in your environment"
      color="warning"
      onCancel={onCancel}
    >
      <Text>
        <Text bold={true}>ANTHROPIC_API_KEY</Text>
        <Text>: sk-ant-...{customApiKeyTruncated}</Text>
      </Text>
      <Text>Do you want to use this API key?</Text>
      <Select
        defaultValue="no"
        defaultFocusValue="no"
        options={options}
        onChange={(value: string) => onChange(value as 'yes' | 'no')}
        onCancel={onCancel}
      />
    </Dialog>
  )
}
