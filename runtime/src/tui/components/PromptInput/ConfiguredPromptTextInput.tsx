import React from 'react'

import type { BaseTextInputProps } from '../../../types/textInputTypes.js'
import TextInput from '../TextInput.js'

export type ConfiguredPromptTextInputProps = {
  baseProps: BaseTextInputProps
}

export function ConfiguredPromptTextInput({
  baseProps,
}: ConfiguredPromptTextInputProps): React.ReactNode {
  return <TextInput {...baseProps} />
}
