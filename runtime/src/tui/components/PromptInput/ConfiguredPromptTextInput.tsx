import React from 'react'

import type {
  BaseTextInputProps,
  VimMode,
} from '../../../types/textInputTypes.js'
import TextInput from '../TextInput.js'
import VimTextInput from '../VimTextInput.js'
import { isVimModeEnabled } from './utils.js'

export type ConfiguredPromptTextInputProps = {
  baseProps: BaseTextInputProps
  vimMode: VimMode
  onVimModeChange: (mode: VimMode) => void
}

export function ConfiguredPromptTextInput({
  baseProps,
  vimMode,
  onVimModeChange,
}: ConfiguredPromptTextInputProps): React.ReactNode {
  return isVimModeEnabled() ? (
    <VimTextInput
      {...baseProps}
      initialMode={vimMode}
      onModeChange={onVimModeChange}
    />
  ) : (
    <TextInput {...baseProps} />
  )
}
