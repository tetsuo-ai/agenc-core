// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { getOriginalCwd, getSessionId } from '../../bootstrap/state';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../hooks/useSearchInput';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { Box, Text, useInput, useTerminalFocus } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index';
import type { LogOption } from '../../types/logs';
import { formatLogMetadata, truncateToWidth } from '../../utils/format.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getWorktreePaths } from '../../utils/getWorktreePaths.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getBranch } from '../../utils/git';
import { getLogDisplayTitle } from '../../utils/log.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getFirstMeaningfulUserMessageTextContent, getSessionIdFromLog, isCustomTitleEnabled, saveCustomTitle } from '../../utils/sessionStorage.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint';
import { Select } from './CustomSelect/select';
import { Byline } from './design-system/Byline';
import { Divider } from './design-system/Divider';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint';
import { SearchBox } from './SearchBox';
import { SessionPreview } from './SessionPreview';
import { TagTabs } from './TagTabs';
import TextInput from './TextInput';
import { type TreeNode, TreeSelect } from './ui/TreeSelect';
export type LogSelectorProps = {
  logs: LogOption[];
  maxHeight?: number;
  forceWidth?: number;
  onCancel?: () => void;
  onSelect: (log: LogOption) => void;
  onLogsChanged?: () => void;
  onLoadMore?: (count: number) => void;
  initialSearchQuery?: string;
  showAllProjects?: boolean;
  onToggleAllProjects?: () => void;
};
type LogTreeNode = TreeNode<{
  log: LogOption;
  indexInFiltered: number;
}>;
function normalizeAndTruncateToWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return truncateToWidth(normalized, maxWidth);
}

// Width of prefixes that TreeSelect will add
const PARENT_PREFIX_WIDTH = 2; // '▼ ' or '▶ '
const CHILD_PREFIX_WIDTH = 4; // '  ▸ '

function buildLogLabel(log: LogOption, maxLabelWidth: number, options?: {
  isGroupHeader?: boolean;
  isChild?: boolean;
  forkCount?: number;
}): string {
  const {
    isGroupHeader = false,
    isChild = false,
    forkCount = 0
  } = options || {};

  // TreeSelect will add the prefix, so we just need to account for its width
  const prefixWidth = isGroupHeader && forkCount > 0 ? PARENT_PREFIX_WIDTH : isChild ? CHILD_PREFIX_WIDTH : 0;
  const sessionCountSuffix = isGroupHeader && forkCount > 0 ? ` (+${forkCount} other ${forkCount === 1 ? 'session' : 'sessions'})` : '';
  const sidechainSuffix = log.isSidechain ? ' (sidechain)' : '';
  const maxSummaryWidth = maxLabelWidth - prefixWidth - sidechainSuffix.length - sessionCountSuffix.length;
  const truncatedSummary = normalizeAndTruncateToWidth(getLogDisplayTitle(log), maxSummaryWidth);
  return `${truncatedSummary}${sidechainSuffix}${sessionCountSuffix}`;
}
function buildLogMetadata(log: LogOption, options?: {
  isChild?: boolean;
  showProjectPath?: boolean;
}): string {
  const {
    isChild = false,
    showProjectPath = false
  } = options || {};
  // Match the child prefix width for proper alignment
  const childPadding = isChild ? '    ' : ''; // 4 spaces to match '  ▸ '
  const baseMetadata = formatLogMetadata(log);
  const projectSuffix = showProjectPath && log.projectPath ? ` · ${log.projectPath}` : '';
  return childPadding + baseMetadata + projectSuffix;
}

type LogSelectorEmptyStateProps = {
  exitState: {
    pending: boolean;
    keyName: string;
  };
};

export function LogSelectorEmptyState({
  exitState
}: LogSelectorEmptyStateProps): React.ReactNode {
  return <Box flexDirection="column" gap={1}>
      <Box flexShrink={0}>
        <Divider color="suggestion" />
      </Box>
      <Text bold={true} color="suggestion">Resume Session</Text>
      <Text dimColor={true}>No resumable sessions found.</Text>
      <Text dimColor={true}>Start a conversation to create resume history.</Text>
      <Text dimColor={true}>
        {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Byline><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline>}
      </Text>
    </Box>;
}

export function LogSelector(t0) {
  const $ = _c(247);
  const {
    logs,
    maxHeight: t1,
    forceWidth,
    onCancel,
    onSelect,
    onLogsChanged,
    onLoadMore,
    initialSearchQuery,
    showAllProjects: t2,
    onToggleAllProjects
  } = t0;
  const maxHeight = t1 === undefined ? Infinity : t1;
  const showAllProjects = t2 === undefined ? false : t2;
  const terminalSize = useTerminalSize();
  const columns = forceWidth === undefined ? terminalSize.columns : forceWidth;
  const exitState = useExitOnCtrlCDWithKeybindings(onCancel);
  const isTerminalFocused = useTerminalFocus();
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = isCustomTitleEnabled();
    $[0] = t3;
  } else {
    t3 = $[0];
  }
  const isResumeWithRenameEnabled = t3;
  const [currentBranch, setCurrentBranch] = React.useState(null);
  const [branchFilterEnabled, setBranchFilterEnabled] = React.useState(false);
  const [showAllWorktrees, setShowAllWorktrees] = React.useState(false);
  const [hasMultipleWorktrees, setHasMultipleWorktrees] = React.useState(false);
  let t6;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = getOriginalCwd();
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  const currentCwd = t6;
  const [renameValue, setRenameValue] = React.useState("");
  const [renameCursorOffset, setRenameCursorOffset] = React.useState(0);
  let t7;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = new Set();
    $[6] = t7;
  } else {
    t7 = $[6];
  }
  const [expandedGroupSessionIds, setExpandedGroupSessionIds] = React.useState(t7);
  const [focusedNode, setFocusedNode] = React.useState(null);
  const [focusedIndex, setFocusedIndex] = React.useState(1);
  const [viewMode, setViewMode] = React.useState("list");
  const [previewLog, setPreviewLog] = React.useState(null);
  const prevFocusedIdRef = React.useRef(null);
  const [selectedTagIndex, setSelectedTagIndex] = React.useState(0);
  const t9 = viewMode === "search";
  let t10;
  let t11;
  let t12;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    t11 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    t12 = ["n"];
    $[8] = t10;
    $[9] = t11;
    $[10] = t12;
  } else {
    t10 = $[8];
    t11 = $[9];
    t12 = $[10];
  }
  const t13 = initialSearchQuery || "";
  let t14;
  if ($[11] !== t13 || $[12] !== t9) {
    t14 = {
      isActive: t9,
      onExit: t10,
      onExitUp: t11,
      passthroughCtrlKeys: t12,
      initialQuery: t13
    };
    $[11] = t13;
    $[12] = t9;
    $[13] = t14;
  } else {
    t14 = $[13];
  }
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput(t14);
  let t17;
  let t18;
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t17 = () => {
      getBranch().then(branch => setCurrentBranch(branch));
      getWorktreePaths(currentCwd).then(paths => {
        setHasMultipleWorktrees(paths.length > 1);
      });
    };
    t18 = [currentCwd];
    $[17] = t17;
    $[18] = t18;
  } else {
    t17 = $[17];
    t18 = $[18];
  }
  React.useEffect(t17, t18);
  let t19;
  t19 = null;
  let t20;
  if ($[19] !== logs) {
    t20 = getUniqueTags(logs);
    $[19] = logs;
    $[20] = t20;
  } else {
    t20 = $[20];
  }
  const uniqueTags = t20;
  const hasTags = uniqueTags.length > 0;
  let t21;
  if ($[21] !== hasTags || $[22] !== uniqueTags) {
    t21 = hasTags ? ["All", ...uniqueTags] : [];
    $[21] = hasTags;
    $[22] = uniqueTags;
    $[23] = t21;
  } else {
    t21 = $[23];
  }
  const tagTabs = t21;
  const effectiveTagIndex = tagTabs.length > 0 && selectedTagIndex < tagTabs.length ? selectedTagIndex : 0;
  const selectedTab = tagTabs[effectiveTagIndex];
  const tagFilter = selectedTab === "All" ? undefined : selectedTab;
  const tagTabsLines = hasTags ? 1 : 0;
  let filtered = logs;
  if (isResumeWithRenameEnabled) {
    let t22;
    if ($[24] !== logs) {
      t22 = logs.filter(_temp2);
      $[24] = logs;
      $[25] = t22;
    } else {
      t22 = $[25];
    }
    filtered = t22;
  }
  if (tagFilter !== undefined) {
    let t22;
    if ($[26] !== filtered || $[27] !== tagFilter) {
      let t23;
      if ($[29] !== tagFilter) {
        t23 = log_2 => log_2.tag === tagFilter;
        $[29] = tagFilter;
        $[30] = t23;
      } else {
        t23 = $[30];
      }
      t22 = filtered.filter(t23);
      $[26] = filtered;
      $[27] = tagFilter;
      $[28] = t22;
    } else {
      t22 = $[28];
    }
    filtered = t22;
  }
  if (branchFilterEnabled && currentBranch) {
    let t22;
    if ($[31] !== currentBranch || $[32] !== filtered) {
      let t23;
      if ($[34] !== currentBranch) {
        t23 = log_3 => log_3.gitBranch === currentBranch;
        $[34] = currentBranch;
        $[35] = t23;
      } else {
        t23 = $[35];
      }
      t22 = filtered.filter(t23);
      $[31] = currentBranch;
      $[32] = filtered;
      $[33] = t22;
    } else {
      t22 = $[33];
    }
    filtered = t22;
  }
  if (hasMultipleWorktrees && !showAllWorktrees) {
    let t22;
    if ($[36] !== filtered) {
      let t23;
      if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
        t23 = log_4 => log_4.projectPath === currentCwd;
        $[38] = t23;
      } else {
        t23 = $[38];
      }
      t22 = filtered.filter(t23);
      $[36] = filtered;
      $[37] = t22;
    } else {
      t22 = $[37];
    }
    filtered = t22;
  }
  const baseFilteredLogs = filtered;
  let t22;
  bb0: {
    if (!searchQuery) {
      t22 = baseFilteredLogs;
      break bb0;
    }
    let t23;
    if ($[39] !== baseFilteredLogs || $[40] !== searchQuery) {
      const query = searchQuery.toLowerCase();
      t23 = baseFilteredLogs.filter(log_5 => {
        const displayedTitle = getLogDisplayTitle(log_5).toLowerCase();
        const branch_0 = (log_5.gitBranch || "").toLowerCase();
        const tag = (log_5.tag || "").toLowerCase();
        const prInfo = log_5.prNumber ? `pr #${log_5.prNumber} ${log_5.prRepository || ""}`.toLowerCase() : "";
        return displayedTitle.includes(query) || branch_0.includes(query) || tag.includes(query) || prInfo.includes(query);
      });
      $[39] = baseFilteredLogs;
      $[40] = searchQuery;
      $[41] = t23;
    } else {
      t23 = $[41];
    }
    t22 = t23;
  }
  const titleFilteredLogs = t22;
  const filteredLogs = titleFilteredLogs;
  const displayedLogs = filteredLogs;
  const maxLabelWidth = Math.max(30, columns - 4);
  let t29;
  bb2: {
    if (!isResumeWithRenameEnabled) {
      let t30;
      if ($[65] === Symbol.for("react.memo_cache_sentinel")) {
        t30 = [];
        $[65] = t30;
      } else {
        t30 = $[65];
      }
      t29 = t30;
      break bb2;
    }
    let t30;
    if ($[66] !== displayedLogs || $[68] !== maxLabelWidth || $[69] !== showAllProjects) {
      const sessionGroups = groupLogsBySessionId(displayedLogs);
      t30 = Array.from(sessionGroups.entries()).map(t31 => {
        const [sessionId, groupLogs] = t31;
        const latestLog = groupLogs[0];
        const indexInFiltered = displayedLogs.indexOf(latestLog);
        if (groupLogs.length === 1) {
          const metadata = buildLogMetadata(latestLog, {
            showProjectPath: showAllProjects
          });
          return {
            id: `log:${sessionId}:0`,
            value: {
              log: latestLog,
              indexInFiltered
            },
            label: buildLogLabel(latestLog, maxLabelWidth),
            description: metadata,
            dimDescription: true
          };
        }
        const forkCount = groupLogs.length - 1;
        const children = groupLogs.slice(1).map((log_8, index) => {
          const childIndexInFiltered = displayedLogs.indexOf(log_8);
          const childMetadata = buildLogMetadata(log_8, {
            isChild: true,
            showProjectPath: showAllProjects
          });
          return {
            id: `log:${sessionId}:${index + 1}`,
            value: {
              log: log_8,
              indexInFiltered: childIndexInFiltered
            },
            label: buildLogLabel(log_8, maxLabelWidth, {
              isChild: true
            }),
            description: childMetadata,
            dimDescription: true
          };
        });
        const parentMetadata = buildLogMetadata(latestLog, {
          showProjectPath: showAllProjects
        });
        return {
          id: `group:${sessionId}`,
          value: {
            log: latestLog,
            indexInFiltered
          },
          label: buildLogLabel(latestLog, maxLabelWidth, {
            isGroupHeader: true,
            forkCount
          }),
          description: parentMetadata,
          dimDescription: true,
          children
        };
      });
      $[66] = displayedLogs;
      $[68] = maxLabelWidth;
      $[69] = showAllProjects;
      $[71] = t30;
    } else {
      t30 = $[71];
    }
    t29 = t30;
  }
  const treeNodes = t29;
  let t30;
  bb3: {
    if (isResumeWithRenameEnabled) {
      let t31;
      if ($[72] === Symbol.for("react.memo_cache_sentinel")) {
        t31 = [];
        $[72] = t31;
      } else {
        t31 = $[72];
      }
      t30 = t31;
      break bb3;
    }
    let t31;
    if ($[73] !== displayedLogs || $[75] !== maxLabelWidth || $[76] !== showAllProjects) {
      let t32;
      if ($[80] !== maxLabelWidth || $[81] !== showAllProjects) {
        t32 = (log_9, index_0) => {
          const rawSummary = getLogDisplayTitle(log_9);
          const summaryWithSidechain = rawSummary + (log_9.isSidechain ? " (sidechain)" : "");
          const summary = normalizeAndTruncateToWidth(summaryWithSidechain, maxLabelWidth);
          const baseDescription = formatLogMetadata(log_9);
          const projectSuffix = showAllProjects && log_9.projectPath ? ` · ${log_9.projectPath}` : "";
          return {
            label: summary,
            description: baseDescription + projectSuffix,
            dimDescription: true,
            value: index_0.toString()
          };
        };
        $[80] = maxLabelWidth;
        $[81] = showAllProjects;
        $[83] = t32;
      } else {
        t32 = $[83];
      }
      t31 = displayedLogs.map(t32);
      $[73] = displayedLogs;
      $[75] = maxLabelWidth;
      $[76] = showAllProjects;
      $[78] = t31;
    } else {
      t31 = $[78];
    }
    t30 = t31;
  }
  const flatOptions = t30;
  const focusedLog = focusedNode?.value.log ?? null;
  let t31;
  if ($[84] !== displayedLogs || $[85] !== expandedGroupSessionIds || $[86] !== focusedLog) {
    t31 = () => {
      if (!isResumeWithRenameEnabled || !focusedLog) {
        return "";
      }
      const sessionId_0 = getSessionIdFromLog(focusedLog);
      if (!sessionId_0) {
        return "";
      }
      const sessionLogs = displayedLogs.filter(log_10 => getSessionIdFromLog(log_10) === sessionId_0);
      const hasMultipleLogs = sessionLogs.length > 1;
      if (!hasMultipleLogs) {
        return "";
      }
      const isExpanded = expandedGroupSessionIds.has(sessionId_0);
      const isChildNode = sessionLogs.indexOf(focusedLog) > 0;
      if (isChildNode) {
        return "\u2190 to collapse";
      }
      return isExpanded ? "\u2190 to collapse" : "\u2192 to expand";
    };
    $[84] = displayedLogs;
    $[85] = expandedGroupSessionIds;
    $[86] = focusedLog;
    $[87] = t31;
  } else {
    t31 = $[87];
  }
  const getExpandCollapseHint = t31;
  let t32;
  if ($[88] !== focusedLog || $[89] !== onLogsChanged || $[90] !== renameValue) {
    t32 = async () => {
      const sessionId_1 = focusedLog ? getSessionIdFromLog(focusedLog) : undefined;
      if (!focusedLog || !sessionId_1) {
        setViewMode("list");
        setRenameValue("");
        return;
      }
      if (renameValue.trim()) {
        await saveCustomTitle(sessionId_1, renameValue.trim(), focusedLog.fullPath);
        if (isResumeWithRenameEnabled && onLogsChanged) {
          onLogsChanged();
        }
      }
      setViewMode("list");
      setRenameValue("");
    };
    $[88] = focusedLog;
    $[89] = onLogsChanged;
    $[90] = renameValue;
    $[91] = t32;
  } else {
    t32 = $[91];
  }
  const handleRenameSubmit = t32;
  let t33;
  if ($[92] === Symbol.for("react.memo_cache_sentinel")) {
    t33 = () => {
      setViewMode("list");
      logEvent("tengu_session_search_toggled", {
        enabled: false
      });
    };
    $[92] = t33;
  } else {
    t33 = $[92];
  }
  const exitSearchMode = t33;
  let t34;
  if ($[93] === Symbol.for("react.memo_cache_sentinel")) {
    t34 = () => {
      setViewMode("search");
      logEvent("tengu_session_search_toggled", {
        enabled: true
      });
    };
    $[93] = t34;
  } else {
    t34 = $[93];
  }
  const enterSearchMode = t34;
  let t42;
  if ($[116] !== displayedLogs) {
    t42 = value => {
      const index_1 = parseInt(value, 10);
      const log_11 = displayedLogs[index_1];
      if (!log_11 || prevFocusedIdRef.current === index_1.toString()) {
        return;
      }
      prevFocusedIdRef.current = index_1.toString();
      setFocusedNode({
        id: index_1.toString(),
        value: {
          log: log_11,
          indexInFiltered: index_1
        },
        label: ""
      });
      setFocusedIndex(index_1 + 1);
    };
    $[116] = displayedLogs;
    $[117] = t42;
  } else {
    t42 = $[117];
  }
  const handleFlatOptionsSelectFocus = t42;
  let t43;
  if ($[118] !== displayedLogs) {
    t43 = node => {
      setFocusedNode(node);
      const index_2 = displayedLogs.findIndex(log_12 => getSessionIdFromLog(log_12) === getSessionIdFromLog(node.value.log));
      if (index_2 >= 0) {
        setFocusedIndex(index_2 + 1);
      }
    };
    $[118] = displayedLogs;
    $[119] = t43;
  } else {
    t43 = $[119];
  }
  const handleTreeSelectFocus = t43;
  let t47;
  if ($[123] === Symbol.for("react.memo_cache_sentinel")) {
    t47 = () => {
      setViewMode("list");
      setRenameValue("");
    };
    $[123] = t47;
  } else {
    t47 = $[123];
  }
  const t48 = viewMode === "rename";
  let t49;
  if ($[124] !== t48) {
    t49 = {
      context: "Settings",
      isActive: t48
    };
    $[124] = t48;
    $[125] = t49;
  } else {
    t49 = $[125];
  }
  useKeybinding("confirm:no", t47, t49);
  let t53;
  if ($[132] !== branchFilterEnabled || $[133] !== focusedLog || $[135] !== hasMultipleWorktrees || $[136] !== hasTags || $[139] !== onToggleAllProjects || $[141] !== setSearchQuery || $[142] !== showAllProjects || $[143] !== showAllWorktrees || $[144] !== tagTabs || $[145] !== uniqueTags || $[146] !== viewMode) {
    t53 = (input, key) => {
      if (viewMode === "preview") {
        return;
      }
      if (viewMode === "rename") {} else {
        if (viewMode === "search") {
          if (input.toLowerCase() === "n" && key.ctrl) {
            exitSearchMode();
          }
        } else {
          if (hasTags && key.tab) {
            const offset = key.shift ? -1 : 1;
            setSelectedTagIndex(prev => {
              const current = prev < tagTabs.length ? prev : 0;
              const newIndex = (current + tagTabs.length + offset) % tagTabs.length;
              const newTab = tagTabs[newIndex];
              logEvent("tengu_session_tag_filter_changed", {
                is_all: newTab === "All",
                tag_count: uniqueTags.length
              });
              return newIndex;
            });
            return;
          }
          const keyIsNotCtrlOrMeta = !key.ctrl && !key.meta;
          const lowerInput = input.toLowerCase();
          if (lowerInput === "a" && key.ctrl && onToggleAllProjects) {
            onToggleAllProjects();
            logEvent("tengu_session_all_projects_toggled", {
              enabled: !showAllProjects
            });
          } else {
            if (lowerInput === "b" && key.ctrl) {
              const newEnabled = !branchFilterEnabled;
              setBranchFilterEnabled(newEnabled);
              logEvent("tengu_session_branch_filter_toggled", {
                enabled: newEnabled
              });
            } else {
              if (lowerInput === "w" && key.ctrl && hasMultipleWorktrees) {
                const newValue = !showAllWorktrees;
                setShowAllWorktrees(newValue);
                logEvent("tengu_session_worktree_filter_toggled", {
                  enabled: newValue
                });
              } else {
                if (lowerInput === "/" && keyIsNotCtrlOrMeta) {
                  setViewMode("search");
                  logEvent("tengu_session_search_toggled", {
                    enabled: true
                  });
                } else {
                  if (lowerInput === "r" && key.ctrl && focusedLog) {
                    setViewMode("rename");
                    setRenameValue("");
                    logEvent("tengu_session_rename_started", {});
                  } else {
                    if (lowerInput === "v" && key.ctrl && focusedLog) {
                      setPreviewLog(focusedLog);
                      setViewMode("preview");
                      logEvent("tengu_session_preview_opened", {
                        messageCount: focusedLog.messageCount
                      });
                    } else {
                      if (focusedLog && keyIsNotCtrlOrMeta && input.length > 0 && !/^\s+$/.test(input)) {
                        setViewMode("search");
                        setSearchQuery(input);
                        logEvent("tengu_session_search_toggled", {
                          enabled: true
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    $[132] = branchFilterEnabled;
    $[133] = focusedLog;
    $[135] = hasMultipleWorktrees;
    $[136] = hasTags;
    $[139] = onToggleAllProjects;
    $[141] = setSearchQuery;
    $[142] = showAllProjects;
    $[143] = showAllWorktrees;
    $[144] = tagTabs;
    $[145] = uniqueTags;
    $[146] = viewMode;
    $[147] = t53;
  } else {
    t53 = $[147];
  }
  let t54;
  if ($[148] === Symbol.for("react.memo_cache_sentinel")) {
    t54 = {
      isActive: true
    };
    $[148] = t54;
  } else {
    t54 = $[148];
  }
  useInput(t53, t54);
  let filterIndicators;
  if ($[149] !== branchFilterEnabled || $[150] !== currentBranch || $[151] !== hasMultipleWorktrees || $[152] !== showAllWorktrees) {
    filterIndicators = [];
    if (branchFilterEnabled && currentBranch) {
      filterIndicators.push(currentBranch);
    }
    if (hasMultipleWorktrees && !showAllWorktrees) {
      filterIndicators.push("current worktree");
    }
    $[149] = branchFilterEnabled;
    $[150] = currentBranch;
    $[151] = hasMultipleWorktrees;
    $[152] = showAllWorktrees;
    $[153] = filterIndicators;
  } else {
    filterIndicators = $[153];
  }
  const showAdditionalFilterLine = filterIndicators.length > 0 && viewMode !== "search";
  const headerLines = 8 + (showAdditionalFilterLine ? 1 : 0) + tagTabsLines;
  const visibleCount = Math.max(1, Math.floor((maxHeight - headerLines - 2) / 3));
  let t55;
  let t56;
  if ($[154] !== displayedLogs.length || $[155] !== focusedIndex || $[156] !== onLoadMore || $[157] !== visibleCount) {
    t55 = () => {
      if (!onLoadMore) {
        return;
      }
      const buffer = visibleCount * 2;
      if (focusedIndex + buffer >= displayedLogs.length) {
        onLoadMore(visibleCount * 3);
      }
    };
    t56 = [focusedIndex, visibleCount, displayedLogs.length, onLoadMore];
    $[154] = displayedLogs.length;
    $[155] = focusedIndex;
    $[156] = onLoadMore;
    $[157] = visibleCount;
    $[158] = t55;
    $[159] = t56;
  } else {
    t55 = $[158];
    t56 = $[159];
  }
  React.useEffect(t55, t56);
  if (logs.length === 0) {
    return <LogSelectorEmptyState exitState={exitState} />;
  }
  if (viewMode === "preview" && previewLog && isResumeWithRenameEnabled) {
    let t57;
    if ($[160] === Symbol.for("react.memo_cache_sentinel")) {
      t57 = () => {
        setViewMode("list");
        setPreviewLog(null);
      };
      $[160] = t57;
    } else {
      t57 = $[160];
    }
    let t58;
    if ($[161] !== onSelect || $[162] !== previewLog) {
      t58 = <SessionPreview log={previewLog} onExit={t57} onSelect={onSelect} />;
      $[161] = onSelect;
      $[162] = previewLog;
      $[163] = t58;
    } else {
      t58 = $[163];
    }
    return t58;
  }
  const t57 = maxHeight - 1;
  let t58;
  if ($[164] === Symbol.for("react.memo_cache_sentinel")) {
    t58 = <Box flexShrink={0}><Divider color="suggestion" /></Box>;
    $[164] = t58;
  } else {
    t58 = $[164];
  }
  let t59;
  if ($[165] === Symbol.for("react.memo_cache_sentinel")) {
    t59 = <Box flexShrink={0}><Text> </Text></Box>;
    $[165] = t59;
  } else {
    t59 = $[165];
  }
  let t60;
  if ($[166] !== columns || $[167] !== displayedLogs.length || $[168] !== effectiveTagIndex || $[169] !== focusedIndex || $[170] !== hasTags || $[171] !== showAllProjects || $[172] !== tagTabs || $[173] !== viewMode || $[174] !== visibleCount) {
    t60 = hasTags ? <TagTabs tabs={tagTabs} selectedIndex={effectiveTagIndex} availableWidth={columns} showAllProjects={showAllProjects} /> : <Box flexShrink={0}><Text bold={true} color="suggestion">Resume Session{viewMode === "list" && displayedLogs.length > visibleCount && <Text dimColor={true}>{" "}({focusedIndex} of {displayedLogs.length})</Text>}</Text></Box>;
    $[166] = columns;
    $[167] = displayedLogs.length;
    $[168] = effectiveTagIndex;
    $[169] = focusedIndex;
    $[170] = hasTags;
    $[171] = showAllProjects;
    $[172] = tagTabs;
    $[173] = viewMode;
    $[174] = visibleCount;
    $[175] = t60;
  } else {
    t60 = $[175];
  }
  const t61 = viewMode === "search";
  let t62;
  if ($[176] !== isTerminalFocused || $[177] !== searchCursorOffset || $[178] !== searchQuery || $[179] !== t61) {
    t62 = <SearchBox query={searchQuery} isFocused={t61} isTerminalFocused={isTerminalFocused} cursorOffset={searchCursorOffset} />;
    $[176] = isTerminalFocused;
    $[177] = searchCursorOffset;
    $[178] = searchQuery;
    $[179] = t61;
    $[180] = t62;
  } else {
    t62 = $[180];
  }
  let t63;
  if ($[181] !== filterIndicators || $[182] !== viewMode) {
    t63 = filterIndicators.length > 0 && viewMode !== "search" && <Box flexShrink={0} paddingLeft={2}><Text dimColor={true}><Byline>{filterIndicators}</Byline></Text></Box>;
    $[181] = filterIndicators;
    $[182] = viewMode;
    $[183] = t63;
  } else {
    t63 = $[183];
  }
  let t64;
  if ($[184] === Symbol.for("react.memo_cache_sentinel")) {
    t64 = <Box flexShrink={0}><Text> </Text></Box>;
    $[184] = t64;
  } else {
    t64 = $[184];
  }
  let t70;
  if ($[203] !== branchFilterEnabled || $[204] !== columns || $[205] !== displayedLogs || $[206] !== expandedGroupSessionIds || $[207] !== flatOptions || $[208] !== focusedLog || $[209] !== focusedNode?.id || $[210] !== handleFlatOptionsSelectFocus || $[211] !== handleRenameSubmit || $[212] !== handleTreeSelectFocus || $[214] !== onCancel || $[215] !== onSelect || $[216] !== renameCursorOffset || $[217] !== renameValue || $[218] !== treeNodes || $[219] !== viewMode || $[220] !== visibleCount) {
    t70 = viewMode === "rename" && focusedLog ? <Box paddingLeft={2} flexDirection="column"><Text bold={true}>Rename session:</Text><Box paddingTop={1}><TextInput value={renameValue} onChange={setRenameValue} onSubmit={handleRenameSubmit} placeholder={getLogDisplayTitle(focusedLog, "Enter new session name")} columns={columns} cursorOffset={renameCursorOffset} onChangeCursorOffset={setRenameCursorOffset} showCursor={true} /></Box></Box> : isResumeWithRenameEnabled ? <TreeSelect nodes={treeNodes} onSelect={node_0 => {
      onSelect(node_0.value.log);
    }} onFocus={handleTreeSelectFocus} onCancel={onCancel} focusNodeId={focusedNode?.id} visibleOptionCount={visibleCount} layout="expanded" isDisabled={viewMode === "search"} hideIndexes={false} isNodeExpanded={nodeId => {
      if (viewMode === "search" || branchFilterEnabled) {
        return true;
      }
      const sessionId_2 = typeof nodeId === "string" && nodeId.startsWith("group:") ? nodeId.substring(6) : null;
      return sessionId_2 ? expandedGroupSessionIds.has(sessionId_2) : false;
    }} onExpand={nodeId_0 => {
      const sessionId_3 = typeof nodeId_0 === "string" && nodeId_0.startsWith("group:") ? nodeId_0.substring(6) : null;
      if (sessionId_3) {
        setExpandedGroupSessionIds(prev_0 => new Set(prev_0).add(sessionId_3));
        logEvent("tengu_session_group_expanded", {});
      }
    }} onCollapse={nodeId_1 => {
      const sessionId_4 = typeof nodeId_1 === "string" && nodeId_1.startsWith("group:") ? nodeId_1.substring(6) : null;
      if (sessionId_4) {
        setExpandedGroupSessionIds(prev_1 => {
          const newSet = new Set(prev_1);
          newSet.delete(sessionId_4);
          return newSet;
        });
      }
    }} onUpFromFirstItem={enterSearchMode} /> : <Select options={flatOptions} onChange={value_0 => {
      const itemIndex = parseInt(value_0, 10);
      const log_13 = displayedLogs[itemIndex];
      if (log_13) {
        onSelect(log_13);
      }
    }} visibleOptionCount={visibleCount} onCancel={onCancel} onFocus={handleFlatOptionsSelectFocus} defaultFocusValue={focusedNode?.id.toString()} layout="expanded" isDisabled={viewMode === "search"} onUpFromFirstItem={enterSearchMode} />;
    $[203] = branchFilterEnabled;
    $[204] = columns;
    $[205] = displayedLogs;
    $[206] = expandedGroupSessionIds;
    $[207] = flatOptions;
    $[208] = focusedLog;
    $[209] = focusedNode?.id;
    $[210] = handleFlatOptionsSelectFocus;
    $[211] = handleRenameSubmit;
    $[212] = handleTreeSelectFocus;
    $[214] = onCancel;
    $[215] = onSelect;
    $[216] = renameCursorOffset;
    $[217] = renameValue;
    $[218] = treeNodes;
    $[219] = viewMode;
    $[220] = visibleCount;
    $[221] = t70;
  } else {
    t70 = $[221];
  }
  let t71;
  if ($[223] !== currentBranch || $[224] !== exitState.keyName || $[225] !== exitState.pending || $[226] !== getExpandCollapseHint || $[227] !== hasMultipleWorktrees || $[230] !== onToggleAllProjects || $[231] !== showAllProjects || $[232] !== showAllWorktrees || $[233] !== viewMode) {
    t71 = <Box paddingLeft={2}>{exitState.pending ? <Text dimColor={true}>Press {exitState.keyName} again to exit</Text> : viewMode === "rename" ? <Text dimColor={true}><Byline><KeyboardShortcutHint shortcut="Enter" action="save" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text> : viewMode === "search" ? <Text dimColor={true}><Byline><Text>Type to Search</Text><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="clear" /></Byline></Text> : <Text dimColor={true}><Byline>{onToggleAllProjects && <KeyboardShortcutHint shortcut="Ctrl+A" action={`show ${showAllProjects ? "current dir" : "all projects"}`} />}{currentBranch && <KeyboardShortcutHint shortcut="Ctrl+B" action="toggle branch" />}{hasMultipleWorktrees && <KeyboardShortcutHint shortcut="Ctrl+W" action={`show ${showAllWorktrees ? "current worktree" : "all worktrees"}`} />}<KeyboardShortcutHint shortcut="Ctrl+V" action="preview" /><KeyboardShortcutHint shortcut="Ctrl+R" action="rename" /><Text>Type to search</Text><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />{getExpandCollapseHint() && <Text>{getExpandCollapseHint()}</Text>}</Byline></Text>}</Box>;
    $[223] = currentBranch;
    $[224] = exitState.keyName;
    $[225] = exitState.pending;
    $[226] = getExpandCollapseHint;
    $[227] = hasMultipleWorktrees;
    $[230] = onToggleAllProjects;
    $[231] = showAllProjects;
    $[232] = showAllWorktrees;
    $[233] = viewMode;
    $[234] = t71;
  } else {
    t71 = $[234];
  }
  let t72;
  if ($[235] !== t57 || $[236] !== t60 || $[237] !== t62 || $[238] !== t63 || $[244] !== t70 || $[245] !== t71) {
    t72 = <Box flexDirection="column" height={t57}>{t58}{t59}{t60}{t62}{t63}{t64}{t70}{t71}</Box>;
    $[235] = t57;
    $[236] = t60;
    $[237] = t62;
    $[238] = t63;
    $[244] = t70;
    $[245] = t71;
    $[246] = t72;
  } else {
    t72 = $[246];
  }
  return t72;
}

function _temp2(log_1) {
  const currentSessionId = getSessionId();
  const logSessionId = getSessionIdFromLog(log_1);
  const isCurrentSession = currentSessionId && logSessionId === currentSessionId;
  if (isCurrentSession) {
    return true;
  }
  if (log_1.customTitle) {
    return true;
  }
  const fromMessages = getFirstMeaningfulUserMessageTextContent(log_1.messages);
  if (fromMessages) {
    return true;
  }
  if (log_1.firstPrompt || log_1.customTitle) {
    return true;
  }
  return false;
}
function groupLogsBySessionId(filteredLogs: LogOption[]): Map<string, LogOption[]> {
  const groups = new Map<string, LogOption[]>();
  for (const log of filteredLogs) {
    const sessionId = getSessionIdFromLog(log);
    if (sessionId) {
      const existing = groups.get(sessionId);
      if (existing) {
        existing.push(log);
      } else {
        groups.set(sessionId, [log]);
      }
    }
  }

  // Sort logs within each group by modified date (newest first)
  groups.forEach(logs => logs.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()));
  return groups;
}

/**
 * Get unique tags from a list of logs, sorted alphabetically
 */
function getUniqueTags(logs: LogOption[]): string[] {
  const tags = new Set<string>();
  for (const log of logs) {
    if (log.tag) {
      tags.add(log.tag);
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}
