import React from 'react'
import { Box, Text } from '../../ink-public.js'
import { glyphs } from '../glyphs.js'
import type { OptionWithDescription } from './select.js'
import { SelectInputOption } from './select-input-option.js'
import { SelectOption } from './select-option.js'
import { useMultiSelectState } from './use-multi-select-state.js'

export type SelectMultiProps<T> = {
  readonly isDisabled?: boolean
  readonly visibleOptionCount?: number
  readonly options: readonly OptionWithDescription<T>[]
  readonly defaultValue?: T[]
  readonly onCancel: () => void
  readonly onChange?: (values: T[]) => void
  readonly onFocus?: (value: T) => void
  readonly focusValue?: T
  /**
   * Text for the submit button. When provided, a submit button is shown and
   * Enter toggles selection (submit only fires when the button is focused).
   * When omitted, Enter submits directly and Space toggles selection.
   */
  readonly submitButtonText?: string
  /**
   * Callback when user submits. Receives the currently selected values.
   */
  readonly onSubmit?: (values: T[]) => void
  /**
   * When true, hides the numeric indexes next to each option.
   */
  readonly hideIndexes?: boolean
  /**
   * Callback when user presses down from the last item (submit button).
   * If provided, navigation will not wrap to the first item.
   */
  readonly onDownFromLastItem?: () => void
  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void
  /**
   * Focus the last option initially instead of the first.
   */
  readonly initialFocusLast?: boolean
  /**
   * Callback to open external editor for editing input option values.
   * Stub: forwarded to {@link SelectInputOption} which currently ignores it.
   * TODO(tranche-5): wire when AgenC's BaseTextInput lands.
   */
  readonly onOpenEditor?: (
    currentValue: string,
    setValue: (value: string) => void,
  ) => void
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: unknown,
    sourcePath?: string,
  ) => void
  readonly pastedContents?: Record<number, unknown>
  readonly onRemoveImage?: (id: number) => void
}

export function SelectMulti<T>({
  isDisabled = false,
  visibleOptionCount = 5,
  options,
  defaultValue = [],
  onCancel,
  onChange,
  onFocus,
  focusValue,
  submitButtonText,
  onSubmit,
  onDownFromLastItem,
  onUpFromFirstItem,
  initialFocusLast,
  onOpenEditor,
  hideIndexes = false,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: SelectMultiProps<T>): React.ReactElement {
  const state = useMultiSelectState<T>({
    isDisabled,
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue,
    submitButtonText,
    onSubmit,
    onDownFromLastItem,
    onUpFromFirstItem,
    initialFocusLast,
    hideIndexes,
  })

  const maxIndexWidth = options.length.toString().length

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {state.visibleOptions.map((option, index) => {
          const isOptionFocused =
            !isDisabled &&
            state.focusedValue === option.value &&
            !state.isSubmitFocused
          const isSelected = state.selectedValues.includes(option.value)
          const isFirstVisibleOption = option.index === state.visibleFromIndex
          const isLastVisibleOption =
            option.index === state.visibleToIndex - 1
          const areMoreOptionsBelow = state.visibleToIndex < options.length
          const areMoreOptionsAbove = state.visibleFromIndex > 0
          const i = state.visibleFromIndex + index + 1

          if (option.type === 'input') {
            const inputValue = state.inputValues.get(option.value) || ''
            return (
              <Box key={String(option.value)} gap={1}>
                <SelectInputOption
                  option={option}
                  isFocused={isOptionFocused}
                  isSelected={false}
                  shouldShowDownArrow={
                    areMoreOptionsBelow && isLastVisibleOption
                  }
                  shouldShowUpArrow={
                    areMoreOptionsAbove && isFirstVisibleOption
                  }
                  maxIndexWidth={maxIndexWidth}
                  index={i}
                  inputValue={inputValue}
                  onInputChange={value => {
                    state.updateInputValue(option.value, value)
                  }}
                  onSubmit={() => {
                    /* multi-select handles its own submit */
                  }}
                  onExit={() => {
                    onCancel()
                  }}
                  layout="compact"
                  onOpenEditor={onOpenEditor}
                  onImagePaste={onImagePaste}
                  pastedContents={pastedContents}
                  onRemoveImage={onRemoveImage}
                >
                  <Text color={isSelected ? 'success' : undefined}>
                    [{isSelected ? glyphs.tick : ' '}]{' '}
                  </Text>
                </SelectInputOption>
              </Box>
            )
          }

          return (
            <Box key={String(option.value)} gap={1}>
              <SelectOption
                isFocused={isOptionFocused}
                isSelected={false}
                shouldShowDownArrow={
                  areMoreOptionsBelow && isLastVisibleOption
                }
                shouldShowUpArrow={
                  areMoreOptionsAbove && isFirstVisibleOption
                }
                description={option.description}
              >
                {!hideIndexes && (
                  <Text dimColor={true}>{`${i}.`.padEnd(maxIndexWidth)}</Text>
                )}
                <Text color={isSelected ? 'success' : undefined}>
                  [{isSelected ? glyphs.tick : ' '}]
                </Text>
                <Text color={isOptionFocused ? 'accent' : undefined}>
                  {option.label}
                </Text>
              </SelectOption>
            </Box>
          )
        })}
      </Box>
      {submitButtonText && onSubmit && (
        <Box marginTop={0} gap={1}>
          {state.isSubmitFocused ? (
            <Text color="accent">{glyphs.pointer}</Text>
          ) : (
            <Text> </Text>
          )}
          <Box marginLeft={3}>
            <Text
              color={state.isSubmitFocused ? 'accent' : undefined}
              bold={true}
            >
              {submitButtonText}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
