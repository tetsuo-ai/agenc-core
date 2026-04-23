import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import type { Color } from "../ink/styles.js";
import {
  useKeybinding,
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";
import { getDisplayForCommand } from "../keybindings/shortcutFormat.js";
import { theme } from "../theme.js";

export interface ModelSelectionItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value?: string;
  readonly keywords?: readonly string[];
  readonly searchValue?: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export interface ModelSelectionOverlayProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly tabs?: readonly string[];
  readonly activeTab?: string;
  readonly onTabChange?: (tab: string) => void;
  readonly items: readonly ModelSelectionItem[];
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly onSelect: (item: ModelSelectionItem) => void;
  readonly onSelectionChange?: (item: ModelSelectionItem) => void;
  readonly onClose: () => void;
  readonly onBack?: () => void;
}

function cycleIndex(
  current: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

const DEFAULT_VISIBLE_ROWS = 8;
const MIN_VISIBLE_ROWS = 4;
const CHROME_ROWS_WITHOUT_SUBTITLE = 8;
const CHROME_ROWS_WITH_SUBTITLE = 9;

function readVisibleRows(
  terminalRows: number | undefined,
  hasSubtitle: boolean,
): number {
  if (typeof terminalRows !== "number" || terminalRows <= 0) {
    return DEFAULT_VISIBLE_ROWS;
  }
  const chromeRows = hasSubtitle
    ? CHROME_ROWS_WITH_SUBTITLE
    : CHROME_ROWS_WITHOUT_SUBTITLE;
  return Math.max(MIN_VISIBLE_ROWS, terminalRows - chromeRows);
}

function visibleWindow(
  selectedIndex: number,
  totalItems: number,
  visibleRows: number,
): { readonly start: number; readonly end: number } {
  if (totalItems <= 0) {
    return { start: 0, end: 0 };
  }
  if (totalItems <= visibleRows) {
    return { start: 0, end: totalItems };
  }
  const half = Math.floor(visibleRows / 2);
  const maxStart = Math.max(0, totalItems - visibleRows);
  const start = Math.max(
    0,
    Math.min(maxStart, selectedIndex - half),
  );
  return {
    start,
    end: Math.min(totalItems, start + visibleRows),
  };
}

function isPrintableSearchInput(event: InputEvent): boolean {
  if (typeof event.input !== "string" || event.input.length === 0) return false;
  if (event.key.ctrl || event.key.meta || event.key.super) return false;
  if (
    event.key.return ||
    event.key.escape ||
    event.key.tab ||
    event.key.upArrow ||
    event.key.downArrow ||
    event.key.leftArrow ||
    event.key.rightArrow ||
    event.key.home ||
    event.key.end ||
    event.key.backspace ||
    event.key.delete
  ) {
    return false;
  }
  return true;
}

function itemSearchValue(item: ModelSelectionItem): string {
  return [
    item.searchValue,
    item.label,
    item.description,
    item.value,
    ...(item.keywords ?? []),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLocaleLowerCase();
}

function filterItems(
  items: readonly ModelSelectionItem[],
  searchValues: readonly string[],
  query: string,
): readonly ModelSelectionItem[] {
  const foldedQuery = query.trim().toLocaleLowerCase();
  if (foldedQuery.length === 0) return items;
  return items.filter((_, index) =>
    (searchValues[index] ?? "").includes(foldedQuery),
  );
}

function isItemDisabled(item: ModelSelectionItem | undefined): boolean {
  if (!item) return true;
  return (
    item.disabled === true ||
    (typeof item.disabledReason === "string" && item.disabledReason.length > 0)
  );
}

function findSelectableIndex(
  items: readonly ModelSelectionItem[],
  start: number,
  delta: number,
): number {
  if (items.length === 0) return 0;
  for (let offset = 0; offset < items.length; offset += 1) {
    const index =
      ((start + delta * offset) % items.length + items.length) % items.length;
    if (!isItemDisabled(items[index])) return index;
  }
  return Math.max(0, Math.min(start, items.length - 1));
}

function normalizeSelectedIndex(
  items: readonly ModelSelectionItem[],
  requested: number,
): number {
  if (items.length === 0) return 0;
  const clamped = Math.max(0, Math.min(requested, items.length - 1));
  if (!isItemDisabled(items[clamped])) return clamped;
  return findSelectableIndex(items, clamped, +1);
}

export const ModelSelectionOverlay: React.FC<ModelSelectionOverlayProps> = ({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  items,
  searchable = true,
  searchPlaceholder,
  onSelect,
  onSelectionChange,
  onClose,
  onBack,
}) => {
  const stdin = useContext(StdinContext);
  const terminalSize = useContext(TerminalSizeContext);
  const setActiveContext = useSetKeybindingContext();
  const [searchQuery, setSearchQuery] = useState("");
  const searchValues = useMemo(
    () => items.map((item) => itemSearchValue(item)),
    [items],
  );
  const filteredItems = useMemo(
    () => filterItems(items, searchValues, searchable ? searchQuery : ""),
    [items, searchQuery, searchValues, searchable],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [localTabIndex, setLocalTabIndex] = useState<number | null>(null);
  const previousActiveTabRef = useRef(activeTab);
  const accent = theme.colors.primary as Color;
  const secondary = theme.colors.secondary as Color;
  const dim = theme.colors.dim as Color;
  const warning = theme.colors.warning as Color;
  const visibleRows = useMemo(
    () => readVisibleRows(terminalSize?.rows, Boolean(subtitle)),
    [subtitle, terminalSize?.rows],
  );
  const windowedItems = useMemo(() => {
    const { start, end } = visibleWindow(
      selectedIndex,
      filteredItems.length,
      visibleRows,
    );
    return {
      start,
      end,
      beforeCount: start,
      afterCount: Math.max(0, filteredItems.length - end),
      items: filteredItems.slice(start, end),
    };
  }, [filteredItems, selectedIndex, visibleRows]);

  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  useEffect(() => {
    setSelectedIndex((current) => normalizeSelectedIndex(filteredItems, current));
  }, [filteredItems]);

  useEffect(() => {
    if (previousActiveTabRef.current === activeTab) return;
    previousActiveTabRef.current = activeTab;
    setLocalTabIndex(null);
    setSearchQuery("");
    setSelectedIndex(0);
  }, [activeTab]);

  const derivedActiveTabIndex = useMemo(() => {
    if (!tabs || tabs.length === 0) return -1;
    if (!activeTab) return 0;
    return Math.max(0, tabs.indexOf(activeTab));
  }, [activeTab, tabs]);
  const activeTabIndex =
    localTabIndex !== null && tabs && localTabIndex < tabs.length
      ? localTabIndex
      : derivedActiveTabIndex;

  const handleTabCycle = useCallback(
    (delta: number): void => {
      if (!tabs || tabs.length === 0 || typeof onTabChange !== "function") return;
      const currentIndex = activeTabIndex >= 0 ? activeTabIndex : 0;
      const nextTab = tabs[cycleIndex(currentIndex, delta, tabs.length)];
      if (nextTab) {
        setLocalTabIndex(tabs.indexOf(nextTab));
        setSearchQuery("");
        setSelectedIndex(0);
        onTabChange(nextTab);
      }
    },
    [activeTabIndex, onTabChange, tabs],
  );

  const selectedItem = filteredItems[selectedIndex] ?? null;

  useEffect(() => {
    if (!selectedItem || typeof onSelectionChange !== "function") return;
    onSelectionChange(selectedItem);
  }, [onSelectionChange, selectedItem]);

  const handleDismiss = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    onClose();
  }, [onBack, onClose]);

  const handleConfirm = useCallback(() => {
    if (filteredItems.length === 0) {
      handleDismiss();
      return;
    }
    if (selectedItem && !isItemDisabled(selectedItem)) {
      onSelect(selectedItem);
    }
  }, [filteredItems.length, handleDismiss, onSelect, selectedItem]);

  useKeybinding("modal:confirm", handleConfirm, "modal");
  useKeybinding("modal:yes", handleConfirm, "modal");
  useKeybinding("modal:cancel", handleDismiss, "modal");
  useKeybinding("modal:no", handleDismiss, "modal");
  useKeybinding("modal:deny", handleDismiss, "modal");

  useEffect(() => {
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const listener = (event: InputEvent): void => {
      if (event.key.tab && !event.key.shift) {
        handleTabCycle(1);
        return;
      }
      if (event.key.tab && event.key.shift) {
        handleTabCycle(-1);
        return;
      }
      if (event.key.leftArrow && tabs && tabs.length > 0) {
        handleTabCycle(-1);
        return;
      }
      if (event.key.rightArrow && tabs && tabs.length > 0) {
        handleTabCycle(1);
        return;
      }
      if (searchable && event.key.ctrl && event.input.toLowerCase() === "u") {
        setSearchQuery("");
        return;
      }
      if (searchable && event.key.backspace) {
        setSearchQuery((current) =>
          current.slice(0, Math.max(0, current.length - 1)),
        );
        return;
      }
      if (event.key.upArrow) {
        setSelectedIndex((current) =>
          findSelectableIndex(filteredItems, current - 1, -1),
        );
        return;
      }
      if (event.key.downArrow) {
        setSelectedIndex((current) =>
          findSelectableIndex(filteredItems, current + 1, +1),
        );
        return;
      }
      if (!searchable && /^[1-9]$/.test(event.input)) {
        const target = Number.parseInt(event.input, 10) - 1;
        const nextIndex = normalizeSelectedIndex(filteredItems, target);
        const targetItem = filteredItems[nextIndex];
        if (!targetItem || isItemDisabled(targetItem)) return;
        setSelectedIndex(nextIndex);
        onSelect(targetItem);
        return;
      }
      if (searchable && isPrintableSearchInput(event)) {
        setSearchQuery((current) => current + event.input);
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [
    filteredItems,
    handleTabCycle,
    onSelect,
    searchable,
    stdin,
    tabs,
  ]);

  const tabLine = useMemo(() => {
    if (!tabs || tabs.length === 0) return null;
    const visibleActiveTab =
      activeTabIndex >= 0 ? tabs[activeTabIndex] : activeTab;
    return tabs
      .map((tab) => (tab === visibleActiveTab ? `[${tab}]` : tab))
      .join("  ");
  }, [activeTab, activeTabIndex, tabs]);
  const confirmKey = getDisplayForCommand("modal:confirm", "modal") ?? "Enter";
  const cancelKey = getDisplayForCommand("modal:cancel", "modal") ?? "Esc";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={0}>
      <Box flexDirection="column">
        <Text bold color={accent}>{title}</Text>
        {subtitle ? <Text color={dim}>{subtitle}</Text> : null}
        {tabLine ? <Text color={secondary}>{tabLine}</Text> : null}
        {searchable ? (
          <Text color={dim}>
            {`Search: ${searchQuery.length > 0 ? searchQuery : searchPlaceholder ?? "type to filter"}`}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {filteredItems.length === 0 ? (
          <Text color={dim}>
            {searchQuery.length > 0 ? "No matches." : "No options available."}
          </Text>
        ) : (
          <>
            {windowedItems.beforeCount > 0 ? (
              <Text color={dim}>{`↑ ${windowedItems.beforeCount} more`}</Text>
            ) : null}
            {windowedItems.items.map((item, offset) => {
              const index = windowedItems.start + offset;
              const isSelected = index === selectedIndex;
              return (
                <Box key={item.id} flexDirection="column" marginBottom={0}>
                  <Text
                    inverse={isSelected}
                    color={isSelected ? undefined : accent}
                  >
                    {item.label}
                  </Text>
                  {item.description ? (
                    <Text color={dim}>{item.description}</Text>
                  ) : null}
                  {isItemDisabled(item) ? (
                    <Text color={warning}>
                      {item.disabledReason ?? "Unavailable"}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            {windowedItems.afterCount > 0 ? (
              <Text color={dim}>{`↓ ${windowedItems.afterCount} more`}</Text>
            ) : null}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={dim}>
          {onBack
            ? `${confirmKey} selects · ${cancelKey} goes back`
            : `${confirmKey} selects · ${cancelKey} closes`}
          {tabs && tabs.length > 1 ? " · Tab / ← → switches tabs" : ""}
          {searchable ? " · type to filter · Ctrl+U clears" : " · 1-9 selects"}
        </Text>
      </Box>
    </Box>
  );
};

export default ModelSelectionOverlay;
