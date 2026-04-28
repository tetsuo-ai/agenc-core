import { useMemo } from 'react'
import { useInput } from '../../ink-public.js'
import type { InputEvent } from '../../ink/events/input-event.js'
import type { OptionWithDescription } from './select.js'
import type { SelectState } from './use-select-state.js'

// Inline string normalization helpers. AgenC has no shared
// `utils/stringUtils` yet, and we only need full-width digit / space
// handling for direct numeric and multi-select space-toggle input.
const FULL_WIDTH_DIGIT_OFFSET = 0xff10 - 0x30
function normalizeFullWidthDigits(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - FULL_WIDTH_DIGIT_OFFSET)
    } else {
      out += input[i]
    }
  }
  return out
}
function normalizeFullWidthSpace(input: string): string {
  return input === '　' ? ' ' : input
}

export type UseSelectProps<T> = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  isDisabled?: boolean

  /**
   * When true, prevents selection on Enter or number keys, but allows
   * scrolling.
   * When 'numeric', prevents selection on number keys, but allows Enter (and
   * scrolling).
   *
   * @default false
   */
  readonly disableSelection?: boolean | 'numeric'

  /**
   * Select state.
   */
  state: SelectState<T>

  /**
   * Options.
   */
  options: readonly OptionWithDescription<T>[]

  /**
   * Whether this is a multi-select component.
   *
   * @default false
   */
  isMultiSelect?: boolean

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  onUpFromFirstItem?: () => void

  /**
   * Callback when user presses down from the last item.
   * If provided, navigation will not wrap to the first item.
   */
  onDownFromLastItem?: () => void

  /**
   * Callback when input mode should be toggled for an option.
   * Called when Tab is pressed (to enter or exit input mode).
   */
  onInputModeToggle?: (value: T) => void

  /**
   * Current input values for input-type options.
   * Used to determine if number key should submit an empty input option.
   */
  inputValues?: Map<T, string>

  /**
   * Whether image selection mode is active on the focused input option.
   * When true, arrow key navigation in useInput is suppressed so that
   * Attachments keybindings can handle image navigation instead.
   */
  imagesSelected?: boolean

  /**
   * Callback to attempt entering image selection mode on DOWN arrow.
   * Returns true if image selection was entered (images exist), false otherwise.
   */
  onEnterImageSelection?: () => boolean
}

/**
 * Wires keyboard input for the {@link Select} widget.
 *
 * The upstream parity contract routes navigation/accept/cancel through a
 * declarative keybinding system (`select:next` / `select:previous` /
 * `select:accept` / `select:cancel`). AgenC's keybinding registry does
 * not yet define those commands, so we drive arrow / enter / escape
 * directly off `useInput`. Behavior parity is preserved:
 *
 *   - `up` / `ctrl+p` / `k`     -> focus previous (with first-item exit)
 *   - `down` / `ctrl+n` / `j`   -> focus next (with last-item exit)
 *   - `enter`                   -> accept (unless `disableSelection`)
 *   - `escape`                  -> cancel (when `state.onCancel` is set)
 *   - `tab`                     -> toggle input mode for focused option
 *   - `pageUp` / `pageDown`     -> page navigation
 *   - digit keys (1-9)          -> direct selection (unless suppressed)
 *   - space (multi-select)      -> toggle focused option
 *
 * Note: the upstream parity contract additionally registers the active
 * select with an overlay context to keep a global cancel handler from
 * intercepting Escape. AgenC has no equivalent global Escape handler
 * today, so the registration is dropped.
 * TODO(tranche-3): once an Escape-routing surface exists, wire it back in.
 */
export const useSelectInput = <T>({
  isDisabled = false,
  disableSelection = false,
  state,
  options,
  isMultiSelect = false,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle,
  inputValues,
  imagesSelected = false,
  onEnterImageSelection,
}: UseSelectProps<T>) => {
  // Determine if the focused option is an input type.
  const isInInput = useMemo(() => {
    const focusedOption = options.find(opt => opt.value === state.focusedValue)
    return focusedOption?.type === 'input'
  }, [options, state.focusedValue])

  useInput(
    (input, key, event: InputEvent) => {
      const normalizedInput = normalizeFullWidthDigits(input)
      const focusedOption = options.find(
        opt => opt.value === state.focusedValue,
      )
      const currentIsInInput = focusedOption?.type === 'input'

      // Handle Tab key for input mode toggling
      if (key.tab && onInputModeToggle && state.focusedValue !== undefined) {
        onInputModeToggle(state.focusedValue)
        return
      }

      // When focused on an input-type option, only navigation keys should
      // affect the select. Other keys pass through to the embedded text
      // input.
      if (currentIsInInput) {
        // When in image selection mode, suppress all input handling so
        // Attachments keybindings can handle navigation/deletion instead
        if (imagesSelected) return

        // DOWN arrow enters image selection mode if images exist
        if (key.downArrow && onEnterImageSelection?.()) {
          event.stopImmediatePropagation()
          return
        }

        if (key.downArrow || (key.ctrl && input === 'n')) {
          if (onDownFromLastItem) {
            const lastOption = options[options.length - 1]
            if (lastOption && state.focusedValue === lastOption.value) {
              onDownFromLastItem()
              event.stopImmediatePropagation()
              return
            }
          }
          state.focusNextOption()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow || (key.ctrl && input === 'p')) {
          if (onUpFromFirstItem && state.visibleFromIndex === 0) {
            const firstOption = options[0]
            if (firstOption && state.focusedValue === firstOption.value) {
              onUpFromFirstItem()
              event.stopImmediatePropagation()
              return
            }
          }
          state.focusPreviousOption()
          event.stopImmediatePropagation()
          return
        }

        // All other keys (including digits) pass through to the embedded
        // text input. Digits should type literally rather than jump to a
        // different option when a text field is focused.
        return
      }

      // Plain (non-input) navigation
      if (key.upArrow || (key.ctrl && input === 'p')) {
        if (onUpFromFirstItem && state.visibleFromIndex === 0) {
          const firstOption = options[0]
          if (firstOption && state.focusedValue === firstOption.value) {
            onUpFromFirstItem()
            return
          }
        }
        state.focusPreviousOption()
        return
      }

      if (key.downArrow || (key.ctrl && input === 'n')) {
        if (onDownFromLastItem) {
          const lastOption = options[options.length - 1]
          if (lastOption && state.focusedValue === lastOption.value) {
            onDownFromLastItem()
            return
          }
        }
        state.focusNextOption()
        return
      }

      // Accept (enter)
      if (key.return) {
        if (disableSelection === true) return
        if (state.focusedValue === undefined) return
        const focusedOpt = options.find(
          opt => opt.value === state.focusedValue,
        )
        if (focusedOpt?.disabled === true) return
        state.selectFocusedOption?.()
        state.onChange?.(state.focusedValue)
        return
      }

      // Cancel (escape)
      if (key.escape && state.onCancel) {
        state.onCancel()
        event.stopImmediatePropagation()
        return
      }

      if (key.pageDown) {
        state.focusNextPage()
        return
      }

      if (key.pageUp) {
        state.focusPreviousPage()
        return
      }

      if (disableSelection !== true) {
        // Space for multi-select toggle
        if (
          isMultiSelect &&
          normalizeFullWidthSpace(input) === ' ' &&
          state.focusedValue !== undefined
        ) {
          const isFocusedOptionDisabled = focusedOption?.disabled === true
          if (!isFocusedOptionDisabled) {
            state.selectFocusedOption?.()
            state.onChange?.(state.focusedValue)
          }
        }

        if (
          disableSelection !== 'numeric' &&
          /^[0-9]+$/.test(normalizedInput)
        ) {
          const index = parseInt(normalizedInput) - 1
          if (index >= 0 && index < state.options.length) {
            const selectedOption = state.options[index]!
            if (selectedOption.disabled === true) {
              return
            }
            if (selectedOption.type === 'input') {
              const currentValue = inputValues?.get(selectedOption.value) ?? ''
              if (currentValue.trim()) {
                // Pre-filled input: auto-submit (user can Tab to edit instead)
                state.onChange?.(selectedOption.value)
                return
              }
              if (selectedOption.allowEmptySubmitToCancel) {
                state.onChange?.(selectedOption.value)
                return
              }
              state.focusOption(selectedOption.value)
              return
            }
            state.onChange?.(selectedOption.value)
            return
          }
        }
      }
    },
    { isActive: !isDisabled },
  )
}
