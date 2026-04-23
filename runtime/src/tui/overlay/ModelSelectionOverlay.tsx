import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { theme } from "../theme.js";

export interface ModelSelectionItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value?: string;
}

export interface ModelSelectionOverlayProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly tabs?: readonly string[];
  readonly activeTab?: string;
  readonly onTabChange?: (tab: string) => void;
  readonly items: readonly ModelSelectionItem[];
  readonly onSelect: (item: ModelSelectionItem) => void;
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

export const ModelSelectionOverlay: React.FC<ModelSelectionOverlayProps> = ({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  items,
  onSelect,
  onClose,
  onBack,
}) => {
  const stdin = useContext(StdinContext);
  const terminalSize = useContext(TerminalSizeContext);
  const setActiveContext = useSetKeybindingContext();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const accent = theme.colors.primary as Color;
  const secondary = theme.colors.secondary as Color;
  const dim = theme.colors.dim as Color;
  const visibleRows = useMemo(
    () => readVisibleRows(terminalSize?.rows, Boolean(subtitle)),
    [subtitle, terminalSize?.rows],
  );
  const windowedItems = useMemo(() => {
    const { start, end } = visibleWindow(selectedIndex, items.length, visibleRows);
    return {
      start,
      end,
      beforeCount: start,
      afterCount: Math.max(0, items.length - end),
      items: items.slice(start, end),
    };
  }, [items, selectedIndex, visibleRows]);

  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  useEffect(() => {
    setSelectedIndex((current) =>
      items.length === 0 ? 0 : Math.min(current, items.length - 1),
    );
  }, [items]);

  const activeTabIndex = useMemo(() => {
    if (!tabs || tabs.length === 0) return -1;
    if (!activeTab) return 0;
    return Math.max(0, tabs.indexOf(activeTab));
  }, [activeTab, tabs]);

  const handleTabCycle = useCallback(
    (delta: number): void => {
      if (!tabs || tabs.length === 0 || typeof onTabChange !== "function") return;
      const currentIndex = activeTabIndex >= 0 ? activeTabIndex : 0;
      const nextTab = tabs[cycleIndex(currentIndex, delta, tabs.length)];
      if (nextTab) onTabChange(nextTab);
    },
    [activeTabIndex, onTabChange, tabs],
  );

  const selectedItem = items[selectedIndex] ?? null;

  const handleConfirm = useCallback(() => {
    if (selectedItem) {
      onSelect(selectedItem);
    }
  }, [onSelect, selectedItem]);

  const handleDismiss = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    onClose();
  }, [onBack, onClose]);

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
      if (event.key.upArrow || (!event.key.ctrl && event.input === "k")) {
        setSelectedIndex((current) => cycleIndex(current, -1, items.length));
        return;
      }
      if (event.key.downArrow || (!event.key.ctrl && event.input === "j")) {
        setSelectedIndex((current) => cycleIndex(current, 1, items.length));
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [handleTabCycle, items.length, stdin, tabs]);

  const tabLine = useMemo(() => {
    if (!tabs || tabs.length === 0) return null;
    return tabs
      .map((tab) => (tab === activeTab ? `[${tab}]` : tab))
      .join("  ");
  }, [activeTab, tabs]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={0}>
      <Box flexDirection="column">
        <Text bold color={accent}>{title}</Text>
        {subtitle ? <Text color={dim}>{subtitle}</Text> : null}
        {tabLine ? <Text color={secondary}>{tabLine}</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Text color={dim}>No options available.</Text>
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
            ? "Enter selects · Esc goes back"
            : "Enter selects · Esc closes"}
          {tabs && tabs.length > 1 ? " · Tab / ← → switches tabs" : ""}
        </Text>
      </Box>
    </Box>
  );
};

export default ModelSelectionOverlay;
