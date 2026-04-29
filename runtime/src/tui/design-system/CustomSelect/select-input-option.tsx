/**
 * Tranche-2E STUB: `SelectInputOption` — the inline-text-input variant of
 * a {@link SelectOption}. The upstream parity implementation rides on top
 * of a `BaseTextInput`-style editor plus clipboard image paste, external-
 * editor handoff, and an "Attachments" keybinding context for image
 * navigation.
 *
 * AgenC has none of those primitives yet — they belong to tranche-5
 * composer territory. To unblock {@link Select} and {@link SelectMulti}
 * (which both reference `SelectInputOption` for option rows whose
 * `type === 'input'`), this stub renders a compact read-only fallback:
 *
 *   - shows the index + current input value (or placeholder)
 *   - delegates focus / selection styling to `SelectOption`
 *   - swallows {@link onSubmit} / {@link onExit} / image callbacks
 *
 * Behaviorally this means a consumer that ships an option of
 * `{ type: 'input', ... }` will see the row but cannot type into it via
 * AgenC yet. Picking the row by Enter / index still routes through the
 * parent `Select`'s `onChange`.
 *
 * TODO(tranche-5): replace this stub with a real port once
 *   - `BaseTextInput` (or AgenC's composer text editor)
 *   - clipboard image paste utility
 *   - the "Attachments" keybinding context
 *   - `ConfigurableShortcutHint` / `KeyboardShortcutHint` wiring
 * are landed.
 */
import React, { type ReactNode } from 'react'
import { Box, Text } from '../../ink-public.js'
import type { OptionWithDescription } from './select.js'
import { SelectOption } from './select-option.js'

// Preserve the upstream prop shape so `select.tsx` and `SelectMulti.tsx`
// can keep their JSX call sites untouched. Fields that aren't honored
// by the stub are documented inline.
export type SelectInputOptionProps<T> = {
  option: Extract<OptionWithDescription<T>, { type: 'input' }>
  isFocused: boolean
  isSelected: boolean
  shouldShowDownArrow: boolean
  shouldShowUpArrow: boolean
  maxIndexWidth: number
  index: number
  inputValue: string
  onInputChange: (value: string) => void
  onSubmit: (value: string) => void
  onExit?: () => void
  layout: 'compact' | 'expanded'
  children?: ReactNode
  /**
   * When true, shows the label before the input field. Honored visually
   * by the stub.
   */
  showLabel?: boolean
  /**
   * Stub: ignored. TODO(tranche-5): wire to external editor handoff.
   */
  onOpenEditor?: (
    currentValue: string,
    setValue: (value: string) => void,
  ) => void
  /**
   * Stub: ignored. TODO(tranche-5): wire to AgenC's BaseTextInput cursor.
   */
  resetCursorOnUpdate?: boolean
  /**
   * Stub: ignored. TODO(tranche-5): wire to clipboard image paste.
   */
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: unknown,
    sourcePath?: string,
  ) => void
  /**
   * Stub: ignored. TODO(tranche-5): render attached images inline.
   */
  pastedContents?: Record<number, unknown>
  /**
   * Stub: ignored. TODO(tranche-5): hook up image removal.
   */
  onRemoveImage?: (id: number) => void
  /**
   * Stub: ignored. TODO(tranche-5): support image-selection mode.
   */
  imagesSelected?: boolean
  /**
   * Stub: ignored.
   */
  selectedImageIndex?: number
  /**
   * Stub: ignored.
   */
  onImagesSelectedChange?: (selected: boolean) => void
  /**
   * Stub: ignored.
   */
  onSelectedImageIndexChange?: (index: number) => void
}

export function SelectInputOption<T>({
  option,
  isFocused,
  isSelected,
  shouldShowDownArrow,
  shouldShowUpArrow,
  maxIndexWidth,
  index,
  inputValue,
  layout,
  children,
  showLabel: showLabelProp = false,
}: SelectInputOptionProps<T>): React.ReactElement {
  const showLabel = showLabelProp || option.showLabelWithValue === true
  const descriptionPaddingLeft =
    layout === 'expanded' ? maxIndexWidth + 3 : maxIndexWidth + 4
  const indexPrefix = `${index}.`.padEnd(maxIndexWidth + 2)

  // Stub render: surface the current text statically. The real
  // tranche-5 implementation will render an interactive cursor here.
  const valueNode: ReactNode = showLabel ? (
    <>
      <Text color={isFocused ? 'accent' : undefined}>{option.label}</Text>
      {inputValue ? (
        <Text>
          {option.labelValueSeparator ?? ', '}
          {inputValue}
        </Text>
      ) : null}
    </>
  ) : (
    <Text color={inputValue ? undefined : 'dim'}>
      {inputValue || option.placeholder || option.label}
    </Text>
  )

  return (
    <Box flexDirection="column" flexShrink={0}>
      <SelectOption
        isFocused={isFocused}
        isSelected={isSelected}
        shouldShowDownArrow={shouldShowDownArrow}
        shouldShowUpArrow={shouldShowUpArrow}
        declareCursor={false}
      >
        <Box
          flexDirection="row"
          flexShrink={layout === 'compact' ? 0 : undefined}
        >
          <Text dimColor={true}>{indexPrefix}</Text>
          {children}
          {valueNode}
        </Box>
      </SelectOption>
      {option.description ? (
        <Box paddingLeft={descriptionPaddingLeft}>
          <Text
            dimColor={option.dimDescription !== false}
            color={
              isSelected ? 'success' : isFocused ? 'accent' : undefined
            }
          >
            {option.description}
          </Text>
        </Box>
      ) : null}
      {layout === 'expanded' ? <Text> </Text> : null}
    </Box>
  )
}
