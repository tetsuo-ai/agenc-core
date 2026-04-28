/**
 * CollapsedReadSearchContent — collapsed summary of a batch of file
 * read / glob / grep tool calls.
 *
 * Ported from upstream `components/messages/CollapsedReadSearchContent.tsx`.
 *
 * Differences from upstream:
 *   - upstream pulls dozens of fields off a `CollapsedReadSearchGroup`
 *     (`searchCount`, `readCount`, `listCount`, `replCount`,
 *     `mcpCallCount`, `bashCount`, git op annotations, hook info,
 *     team-memory ops, etc.) and renders a long "Searched for X
 *     patterns, read Y files, recalled Z memories" sentence with a
 *     verbose-mode expansion. AgenC's transcript reducer does not yet
 *     emit collapsed groups, so this component takes a narrow
 *     `CollapsedReadSearchSummary` payload that the reducer can fill
 *     in incrementally as the grouping support lands.
 *   - The verbose-mode per-call expansion delegates to the existing
 *     `ToolCell` so the grouped rendering matches the live transcript.
 *   - The "Ctrl+O to expand" hint is wired through AgenC's
 *     `getShortcutDisplay` reverse-lookup helper, matching the rest of
 *     the AgenC keybinding chrome.
 *   - The React Compiler `_c()` cache slots and `useMinDisplayTime`
 *     scaffolding are dropped — they are micro-perf details that the
 *     AgenC transcript renderer does not need at this layer.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../ink-public.js";
import { Spinner } from "../../design-system/Spinner.js";
import { getShortcutDisplay } from "../../keybindings/shortcutFormat.js";
import { ToolCell } from "../ToolCell.js";

/** One verbose-mode entry to expand inside the collapsed group. */
export interface CollapsedReadSearchEntry {
  readonly id: string;
  readonly toolName: string;
  readonly toolArgs?: unknown;
  readonly result?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly isComplete?: boolean;
}

/** Summary counts for the collapsed line. Each field is optional. */
export interface CollapsedReadSearchSummary {
  readonly searchCount?: number;
  readonly readCount?: number;
  readonly listCount?: number;
  readonly mcpCallCount?: number;
  readonly bashCount?: number;
  /** Last hint to show beneath the summary line (file path or pattern). */
  readonly latestHint?: string;
  /** True if any of the calls in this group errored. */
  readonly anyError?: boolean;
}

export interface CollapsedReadSearchContentProps {
  readonly summary: CollapsedReadSearchSummary;
  /** True while the group is still in flight (last group, still loading). */
  readonly isActiveGroup?: boolean;
  /** Verbose mode — show every entry with its own ToolCell. */
  readonly verbose?: boolean;
  /** Verbose-mode entries. Ignored when `verbose` is false. */
  readonly entries?: readonly CollapsedReadSearchEntry[];
}

interface SummaryPart {
  readonly key: string;
  readonly verb: string;
  readonly count: number;
  readonly noun: { readonly singular: string; readonly plural: string };
}

function summaryParts(
  summary: CollapsedReadSearchSummary,
  isActive: boolean,
): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if ((summary.searchCount ?? 0) > 0) {
    parts.push({
      key: "search",
      verb: isActive ? "Searching for" : "Searched for",
      count: summary.searchCount!,
      noun: { singular: "pattern", plural: "patterns" },
    });
  }
  if ((summary.readCount ?? 0) > 0) {
    parts.push({
      key: "read",
      verb: isActive ? "Reading" : "Read",
      count: summary.readCount!,
      noun: { singular: "file", plural: "files" },
    });
  }
  if ((summary.listCount ?? 0) > 0) {
    parts.push({
      key: "list",
      verb: isActive ? "Listing" : "Listed",
      count: summary.listCount!,
      noun: { singular: "directory", plural: "directories" },
    });
  }
  if ((summary.mcpCallCount ?? 0) > 0) {
    parts.push({
      key: "mcp",
      verb: isActive ? "Querying MCP" : "Queried MCP",
      count: summary.mcpCallCount!,
      noun: { singular: "time", plural: "times" },
    });
  }
  if ((summary.bashCount ?? 0) > 0) {
    parts.push({
      key: "bash",
      verb: isActive ? "Running" : "Ran",
      count: summary.bashCount!,
      noun: { singular: "bash command", plural: "bash commands" },
    });
  }
  return parts;
}

export function CollapsedReadSearchContent({
  summary,
  isActiveGroup = false,
  verbose = false,
  entries = [],
}: CollapsedReadSearchContentProps): React.ReactElement | null {
  if (verbose) {
    if (entries.length === 0) return null;
    return (
      <Box flexDirection="column">
        {entries.map((entry) => (
          <ToolCell
            key={entry.id}
            toolName={entry.toolName}
            toolArgs={entry.toolArgs}
            isComplete={entry.isComplete !== false}
            isError={entry.isError === true}
            result={entry.result}
            metadata={entry.metadata}
          />
        ))}
      </Box>
    );
  }

  const parts = summaryParts(summary, isActiveGroup);
  if (parts.length === 0) return null;

  const expandShortcut = getShortcutDisplay(
    "app:toggleTranscript",
    "Global",
    "Ctrl+O",
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {isActiveGroup ? (
          <Box marginRight={1}>
            <Spinner />
          </Box>
        ) : (
          <Box minWidth={2} />
        )}
        <Text color="dim">
          {parts.map((part, idx) => {
            const verb = idx === 0 ? part.verb : part.verb.toLowerCase();
            const noun =
              part.count === 1 ? part.noun.singular : part.noun.plural;
            return (
              <React.Fragment key={part.key}>
                {idx > 0 ? <Text>, </Text> : null}
                <Text>
                  {verb} <Text bold>{String(part.count)}</Text> {noun}
                </Text>
              </React.Fragment>
            );
          })}
          {isActiveGroup ? <Text>…</Text> : null}{" "}
          <Text dimColor>({expandShortcut} to expand)</Text>
        </Text>
      </Box>
      {isActiveGroup &&
      typeof summary.latestHint === "string" &&
      summary.latestHint.length > 0 ? (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text color="dim">{"  ⎿  "}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text color="dim">{summary.latestHint}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export default CollapsedReadSearchContent;
