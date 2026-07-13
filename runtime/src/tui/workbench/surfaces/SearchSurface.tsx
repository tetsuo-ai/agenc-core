import React, { useEffect, useMemo, useRef, useState } from "react";

import { getCwd } from "../../../utils/cwd.js";
import { ripGrepStream } from "../../../utils/ripgrep.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { attachSearchMatchCommand, openBufferCommand } from "../commands.js";
import { groupSearchMatches, parseWorkbenchRipgrepJsonLine, visibleSearchRows } from "../search/model.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import type { SearchMatch } from "../types.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { clampSurfaceSelection } from "./selection.js";

const SEARCH_RESULT_LIMIT = 500;

export function SearchSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const appliedSelectedMatchIdRef = useRef<string | null>(null);
  const query = workbench.searchQuery;
  const selectedMatchId = workbench.selectedSearchMatchId;

  useEffect(() => {
    abortRef.current?.abort();
    appliedSelectedMatchIdRef.current = null;
    setSelected(0);
    setMatches([]);
    if (!query.trim()) {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const cwd = getCwd();
    const next: SearchMatch[] = [];
    const timer = setTimeout(() => {
      void ripGrepStream(
        ["--json", "-i", "-m", "20", "-F", "-e", query],
        cwd,
        controller.signal,
        (lines) => {
          if (controller.signal.aborted) return;
          for (const line of lines) {
            const match = parseWorkbenchRipgrepJsonLine(line, cwd);
            if (match) next.push(match);
            if (next.length >= SEARCH_RESULT_LIMIT) {
              setMatches(next.slice(0, SEARCH_RESULT_LIMIT));
              setLoading(false);
              controller.abort();
              return;
            }
          }
          setMatches(next.slice(0, SEARCH_RESULT_LIMIT));
        },
      )
        .then(() => {
          if (!controller.signal.aborted) setLoading(false);
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            setMatches([]);
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    if (!selectedMatchId) {
      appliedSelectedMatchIdRef.current = null;
      return;
    }
    if (appliedSelectedMatchIdRef.current === selectedMatchId) return;
    const index = matches.findIndex((match) => match.id === selectedMatchId);
    if (index >= 0) {
      appliedSelectedMatchIdRef.current = selectedMatchId;
      setSelected(index);
    }
  }, [matches, selectedMatchId]);

  const selectedIndex = clampSurfaceSelection(selected, matches.length);
  const selectedMatch = matches[selectedIndex] ?? null;
  const groups = useMemo(() => groupSearchMatches(matches), [matches]);
  const disablePendingSelectedMatchRestore = () => {
    if (selectedMatchId) {
      appliedSelectedMatchIdRef.current = selectedMatchId;
    }
  };
  useRegisterKeybindingContext("Surface", focused);
  useKeybindings(
    {
      "surface:up": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => Math.max(0, value - 1));
      },
      "surface:down": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => Math.min(Math.max(0, matches.length - 1), value + 1));
      },
      "surface:pageUp": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => Math.max(0, value - 10));
      },
      "surface:pageDown": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => Math.min(Math.max(0, matches.length - 1), value + 10));
      },
      "surface:top": () => {
        disablePendingSelectedMatchRestore();
        setSelected(0);
      },
      "surface:bottom": () => {
        disablePendingSelectedMatchRestore();
        setSelected(Math.max(0, matches.length - 1));
      },
      "surface:open": () => {
        if (selectedMatch) dispatch(openBufferCommand(selectedMatch.file, selectedMatch.line, true));
      },
      "surface:openKeepFocus": () => {
        if (selectedMatch) dispatch(openBufferCommand(selectedMatch.file, selectedMatch.line, false));
      },
      "surface:attach": () => {
        if (selectedMatch) dispatch(attachSearchMatchCommand(query, selectedMatch));
      },
      "surface:attachAll": () => {
        for (const match of matches) dispatch(attachSearchMatchCommand(query, match));
      },
      "surface:groupUp": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => groupStep(groups, matches, value, -1));
      },
      "surface:groupDown": () => {
        disablePendingSelectedMatchRestore();
        setSelected((value) => groupStep(groups, matches, value, 1));
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (!query.trim()) return <EmptySurface title="SEARCH" message="Open global search or type a query from the composer" />;

  return (
    <SearchSurfaceView
      query={query}
      matches={matches}
      selected={selectedIndex}
      loading={loading}
      error={error}
      focused={focused}
    />
  );
}

export function SearchSurfaceView({
  query,
  matches,
  selected,
  loading,
  error,
  focused,
}: {
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly selected: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly focused: boolean;
}): React.ReactElement {
  const selectedIndex = clampSurfaceSelection(selected, matches.length);
  const selectedMatch = matches[selectedIndex] ?? null;
  const groups = groupSearchMatches(matches);
  const rows = visibleSearchRows(groups);
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="SEARCH" detail={`${query} - ${matches.length} matches`} focused={focused} />
      {loading ? <Text dimColor wrap="truncate-end">searching...</Text> : null}
      {error ? <Text color="error" wrap="truncate-end">{error}</Text> : null}
      {!loading && !error && matches.length === 0 ? <Text dimColor wrap="truncate-end">No results</Text> : null}
      {matches.length >= SEARCH_RESULT_LIMIT ? <Text color="warning" wrap="truncate-end">Results truncated at 500 matches</Text> : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.map((row) =>
          row.kind === "file" ? (
            <Text key={row.id} color="text2" wrap="truncate-end">{row.file} ({row.count})</Text>
          ) : (
            <Text key={row.id} color={matches[selectedIndex]?.id === row.match.id ? "suggestion" : undefined} wrap="truncate-end">
              <Text dimColor>  {row.match.line} </Text>{row.match.text.trim()}
            </Text>
          ),
        )}
      </Box>
      {selectedMatch ? <Text dimColor wrap="truncate-end">enter edit  o keep focus  @ attach  A attach all: {selectedMatch.file}:{selectedMatch.line}</Text> : null}
    </Box>
  );
}

function groupStep(
  groups: readonly { readonly matches: readonly SearchMatch[] }[],
  matches: readonly SearchMatch[],
  selected: number,
  delta: -1 | 1,
): number {
  if (matches.length === 0) return 0;
  const starts: number[] = [];
  let cursor = 0;
  for (const group of groups) {
    starts.push(cursor);
    cursor += group.matches.length;
  }
  if (delta > 0) {
    return starts.find((start) => start > selected) ?? matches.length - 1;
  }
  return [...starts].reverse().find((start) => start < selected) ?? 0;
}
