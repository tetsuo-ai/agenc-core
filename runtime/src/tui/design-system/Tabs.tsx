/**
 * Tabs widget.
 *
 * Header row with selectable tab labels and a content slot below it.
 * Supports both controlled (`selectedTab` + `onTabChange`) and uncontrolled
 * (`defaultTab`) modes. Children are `<Tab title="..." id="...">` elements;
 * only the matching child renders.
 *
 * Header focus model
 * ------------------
 * When the header has focus, ←/→/Tab cycle tabs (handled via the
 * `useInput` hook here directly — AgenC's keybinding map doesn't include
 * dedicated tab-cycle commands, see `defaultBindings.ts`). When the
 * inner content opts into `useTabHeaderFocus()` and the header is focused,
 * pressing `↓` blurs the header so the content can take arrows. Pass
 * `navFromContent` to also let ←/→/Tab cycle tabs from focused content.
 *
 * Modal-aware scroll reset
 * ------------------------
 * When rendered inside a modal slot, the content area uses the modal's
 * shared `ScrollBox` ref and is keyed by `selectedTabIndex` so switching
 * tabs remounts the scroll box and resets `scrollTop` to 0 without
 * timing-sensitive `scrollTo()` calls.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, Text } from '../ink-public.js'
import ScrollBox from '../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import useInput from '../ink/hooks/use-input.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { Theme } from '../theme.js'
import { useModalContext } from './modal-context.js'

type TabsProps = {
  children: Array<React.ReactElement<TabProps>>
  title?: string
  color?: keyof Theme['colors']
  defaultTab?: string
  hidden?: boolean
  useFullWidth?: boolean
  /** Controlled mode: current selected tab id/title. */
  selectedTab?: string
  /** Controlled mode: callback when the active tab changes. */
  onTabChange?: (tabId: string) => void
  /** Optional banner displayed below the tab header row. */
  banner?: React.ReactNode
  /** Disable keyboard navigation (e.g. when a child handles arrows itself). */
  disableNavigation?: boolean
  /**
   * Initial focus state for the tab header row. Defaults to true (header
   * focused, nav always works). Keep the default for Select/list content —
   * those only use up/down so there's no conflict; pass
   * isDisabled={headerFocused} to the Select instead. Only set false when
   * content actually binds left/right/tab (e.g. enum cycling), and show a
   * "↑ tabs" footer hint — without it tabs look broken.
   */
  initialHeaderFocused?: boolean
  /**
   * Fixed height for the content area. When set, all tabs render within the
   * same height (overflow hidden) so switching tabs doesn't cause layout
   * shifts. Shorter tabs get whitespace; taller tabs are clipped.
   */
  contentHeight?: number
  /**
   * Let Tab/←/→ switch tabs from focused content. Opt-in since some
   * content uses those keys; pass a reactive boolean to cede them when
   * needed. Switching from content focuses the header.
   */
  navFromContent?: boolean
}

type TabsContextValue = {
  selectedTab: string | undefined
  width: number | undefined
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
  registerOptIn: () => () => void
}

const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  width: undefined,
  // Default for components rendered outside a Tabs (tests, standalone):
  // content has focus, focusHeader is a no-op.
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
  registerOptIn: () => () => {},
})

export function Tabs({
  title,
  color,
  defaultTab,
  children,
  hidden,
  useFullWidth,
  selectedTab: controlledSelectedTab,
  onTabChange,
  banner,
  disableNavigation,
  initialHeaderFocused = true,
  contentHeight,
  navFromContent = false,
}: TabsProps): React.ReactElement {
  const { columns: terminalWidth } = useTerminalSize()

  const tabs = useMemo<Array<readonly [string, string]>>(
    () =>
      children.map(
        (child) =>
          [
            child.props.id ?? child.props.title,
            child.props.title,
          ] as const,
      ),
    [children],
  )

  const defaultTabIndex = defaultTab
    ? tabs.findIndex((tab) => defaultTab === tab[0])
    : 0
  const isControlled = controlledSelectedTab !== undefined
  const [internalSelectedTab, setInternalSelectedTab] = useState(
    defaultTabIndex !== -1 ? defaultTabIndex : 0,
  )
  const controlledTabIndex = isControlled
    ? tabs.findIndex((tab) => tab[0] === controlledSelectedTab)
    : -1
  const selectedTabIndex = isControlled
    ? controlledTabIndex !== -1
      ? controlledTabIndex
      : 0
    : internalSelectedTab

  const modalCtx = useModalContext()
  const modalScrollRef = modalCtx?.scrollRef ?? null
  const insideModal = modalCtx !== null

  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused)
  const focusHeader = useCallback(() => setHeaderFocused(true), [])
  const blurHeader = useCallback(() => setHeaderFocused(false), [])

  const [optInCount, setOptInCount] = useState(0)
  const registerOptIn = useCallback(() => {
    setOptInCount((n) => n + 1)
    return () => setOptInCount((n) => n - 1)
  }, [])
  const optedIn = optInCount > 0

  const handleTabChange = useCallback(
    (offset: number) => {
      if (tabs.length === 0) return
      const newIndex = (selectedTabIndex + tabs.length + offset) % tabs.length
      const newTabId = tabs[newIndex]?.[0]
      if (isControlled && onTabChange && newTabId) {
        onTabChange(newTabId)
      } else {
        setInternalSelectedTab(newIndex)
      }
      setHeaderFocused(true)
    },
    [tabs, selectedTabIndex, isControlled, onTabChange],
  )

  // Header-row arrow/Tab navigation. AgenC's binding map has no dedicated
  // `tabs:next`/`tabs:previous` commands (see defaultBindings.ts) so we
  // subscribe to `useInput` directly. Two states:
  //   - header focused, not disabled, not hidden: ←/→/Tab cycle tabs
  //   - content focused but `navFromContent` opt-in: same chord set cycles
  //     tabs and re-focuses the header
  const headerNavActive =
    !hidden && !disableNavigation && headerFocused
  const contentNavActive =
    !hidden && !disableNavigation && navFromContent && !headerFocused && optedIn

  // Use the latest handleTabChange via a ref so useInput's stable handler
  // identity (set on mount, see `use-input.ts` listener-order note) keeps
  // firing without re-registering on every render.
  const handleTabChangeRef = useRef(handleTabChange)
  useEffect(() => {
    handleTabChangeRef.current = handleTabChange
  }, [handleTabChange])

  useInput(
    (_input, key) => {
      if (key.leftArrow) {
        handleTabChangeRef.current(-1)
        return
      }
      if (key.rightArrow || key.tab) {
        handleTabChangeRef.current(1)
        return
      }
    },
    { isActive: headerNavActive || contentNavActive },
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!headerFocused || !optedIn || hidden) return
    if (e.key === 'down') {
      e.preventDefault()
      setHeaderFocused(false)
    }
  }

  const titleWidth = title ? stringWidth(title) + 1 : 0
  const tabsWidth = tabs.reduce(
    (sum, [, tabTitle]) =>
      sum + (tabTitle ? stringWidth(tabTitle) : 0) + 2 + 1,
    0,
  )
  const usedWidth = titleWidth + tabsWidth
  const spacerWidth = useFullWidth ? Math.max(0, terminalWidth - usedWidth) : 0
  const contentWidth = useFullWidth ? terminalWidth : undefined

  // Inverse-cursor styling: when a brand color is supplied for a focused
  // tab, render the label as inverted on that color (high-contrast text on
  // the brand swatch). AgenC has no `'inverseText'` color key — `'ink'` is
  // the brightest near-white in the palette.
  const header = !hidden && (
    <Box
      key={`${selectedTabIndex}-${headerFocused ? 'focused' : 'blurred'}`}
      flexDirection="row"
      gap={1}
      flexShrink={insideModal ? 0 : undefined}
    >
      {title !== undefined && (
        <Text bold color={color}>
          {title}
        </Text>
      )}
      {tabs.map(([id, tabTitle], i) => {
        const isCurrent = selectedTabIndex === i
        const hasColorCursor = color && isCurrent && headerFocused
        return (
          <Text
            key={id}
            backgroundColor={hasColorCursor ? color : undefined}
            color={hasColorCursor ? 'ink' : undefined}
            inverse={isCurrent && !hasColorCursor}
            bold={isCurrent}
          >
            {' '}
            {tabTitle}
            {' '}
          </Text>
        )
      })}
      {spacerWidth > 0 && <Text>{' '.repeat(spacerWidth)}</Text>}
    </Box>
  )

  const content = modalScrollRef ? (
    <Box width={contentWidth} marginTop={hidden ? 0 : 1} flexShrink={0}>
      <ScrollBox
        key={selectedTabIndex}
        ref={modalScrollRef}
        flexDirection="column"
        flexShrink={0}
      >
        {children}
      </ScrollBox>
    </Box>
  ) : (
    <Box
      width={contentWidth}
      marginTop={hidden ? 0 : 1}
      height={contentHeight}
      overflowY={contentHeight !== undefined ? 'hidden' : undefined}
    >
      {children}
    </Box>
  )

  return (
    <TabsContext.Provider
      value={{
        selectedTab: tabs[selectedTabIndex]?.[0],
        width: contentWidth,
        headerFocused,
        focusHeader,
        blurHeader,
        registerOptIn,
      }}
    >
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
        flexShrink={insideModal ? 0 : undefined}
      >
        {header}
        {banner}
        {content}
      </Box>
    </TabsContext.Provider>
  )
}

type TabProps = {
  title: string
  id?: string
  children: React.ReactNode
}

export function Tab({ title, id, children }: TabProps): React.ReactElement | null {
  const { selectedTab, width } = useContext(TabsContext)
  const insideModal = useModalContext() !== null

  if (selectedTab !== (id ?? title)) {
    return null
  }

  return (
    <Box width={width} flexShrink={insideModal ? 0 : undefined}>
      {children}
    </Box>
  )
}

export function useTabsWidth(): number | undefined {
  const { width } = useContext(TabsContext)
  return width
}

/**
 * Opt into header-focus gating. Returns the current header focus state and a
 * callback to hand focus back to the tab row. For a Select, pass
 * `isDisabled={headerFocused}` and `onUpFromFirstItem={focusHeader}`; keep the
 * parent Tabs' initialHeaderFocused at its default so tab/←/→ work on mount.
 *
 * Calling this hook registers a ↓-blurs-header opt-in on mount. Don't call it
 * above an early return that renders static text — ↓ will blur the header with
 * no onUpFromFirstItem to recover. Split the component so the hook only runs
 * when the Select renders.
 */
export function useTabHeaderFocus(): {
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
} {
  const { headerFocused, focusHeader, blurHeader, registerOptIn } =
    useContext(TabsContext)
  useEffect(() => registerOptIn(), [registerOptIn])
  return { headerFocused, focusHeader, blurHeader }
}
