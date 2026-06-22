import React from "react";

import { Box, useInput } from "../tui/ink.js";
import { useModalOrTerminalSize } from "../tui/context/modalContext.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { EditDiffView } from "../tui/tool-rendering.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

export type DiffFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "changed"
  | "untracked";

export type DiffFileRow = {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary?: boolean;
  readonly previewLines: readonly string[];
};

export type DiffMenuSnapshot = {
  readonly state: "not-repo" | "clean" | "changed";
  readonly files: readonly DiffFileRow[];
  readonly rawDiff: string;
  readonly untrackedFiles: readonly string[];
};

function statusLabel(status: string): DiffFileStatus {
  const code = status.trim().slice(0, 1).toUpperCase();
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    default:
      return "changed";
  }
}

function parseNameStatus(raw: string): Map<string, DiffFileStatus> {
  const byPath = new Map<string, DiffFileStatus>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\t+/);
    const status = parts[0] ?? "";
    const path = parts.at(-1) ?? "";
    if (path.length > 0) byPath.set(path, statusLabel(status));
  }
  return byPath;
}

function parseNumstat(raw: string): Map<string, Pick<DiffFileRow, "additions" | "deletions" | "binary">> {
  const byPath = new Map<string, Pick<DiffFileRow, "additions" | "deletions" | "binary">>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [addRaw, delRaw, ...pathParts] = trimmed.split(/\t+/);
    const path = destinationPathFromNumstat(pathParts.join("\t"));
    if (path.length === 0) continue;
    const binary = addRaw === "-" || delRaw === "-";
    byPath.set(path, {
      binary,
      additions: binary ? undefined : Number.parseInt(addRaw ?? "0", 10),
      deletions: binary ? undefined : Number.parseInt(delRaw ?? "0", 10),
    });
  }
  return byPath;
}

function destinationPathFromNumstat(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.includes(" => ")) return trimmed;
  const expanded = trimmed.replace(/\{([^{}]*?) => ([^{}]*?)\}/gu, "$2");
  if (expanded !== trimmed) return expanded;
  return trimmed.slice(trimmed.lastIndexOf(" => ") + " => ".length).trim();
}

function diffPathFromHeader(line: string): string | null {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
  if (!match) return null;
  return match[2] === "/dev/null" ? match[1] ?? null : match[2] ?? null;
}

function parseDiffSections(raw: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentPath: string | null = null;
  for (const line of raw.split("\n")) {
    const nextPath = diffPathFromHeader(line);
    if (nextPath !== null) {
      currentPath = nextPath;
      sections.set(currentPath, [line]);
      continue;
    }
    if (currentPath === null) continue;
    sections.get(currentPath)?.push(line);
  }
  return sections;
}

function previewLinesFor(path: string, sections: Map<string, string[]>): readonly string[] {
  const lines = sections.get(path) ?? [];
  return lines
    .filter(line =>
      line.startsWith("diff --git") ||
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" "),
    )
    .slice(0, 28);
}

export function createDiffMenuSnapshot(params: {
  readonly rawDiff: string;
  readonly nameStatus: string;
  readonly numstat: string;
  readonly untrackedFiles: readonly string[];
  readonly notRepo?: boolean;
}): DiffMenuSnapshot {
  if (params.notRepo === true) {
    return {
      state: "not-repo",
      files: [],
      rawDiff: "",
      untrackedFiles: [],
    };
  }

  const statusByPath = parseNameStatus(params.nameStatus);
  const statsByPath = parseNumstat(params.numstat);
  const sections = parseDiffSections(params.rawDiff);
  const paths = new Set<string>([
    ...statusByPath.keys(),
    ...statsByPath.keys(),
    ...sections.keys(),
  ]);
  const files: DiffFileRow[] = [...paths].sort((a, b) => a.localeCompare(b)).map(path => {
    const stats = statsByPath.get(path);
    return {
      path,
      status: statusByPath.get(path) ?? "changed",
      ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
      ...(stats?.binary === true ? { binary: true } : {}),
      previewLines: previewLinesFor(path, sections),
    };
  });
  for (const path of params.untrackedFiles) {
    files.push({
      path,
      status: "untracked",
      previewLines: ["untracked file", "Run git add if this file should be committed."],
    });
  }

  return {
    state: files.length === 0 ? "clean" : "changed",
    files,
    rawDiff: params.rawDiff,
    untrackedFiles: params.untrackedFiles,
  };
}

function statusColor(status: DiffFileStatus): "success" | "agenc" | "worker" | "error" | "inactive" {
  switch (status) {
    case "added":
    case "copied":
      return "success";
    case "modified":
    case "changed":
      return "agenc";
    case "renamed":
      return "worker";
    case "deleted":
    case "unmerged":
      return "error";
    case "untracked":
      return "inactive";
  }
}

function statusGlyph(status: DiffFileStatus): string {
  switch (status) {
    case "added":
      return "+";
    case "deleted":
      return "-";
    case "renamed":
      return ">";
    case "copied":
      return "=";
    case "unmerged":
      return "!";
    case "untracked":
      return "?";
    case "modified":
    case "changed":
      return "*";
  }
}

function formatDelta(file: DiffFileRow): string {
  if (file.binary) return "binary";
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  return `+${additions} -${deletions}`;
}

function previewColor(line: string): "success" | "error" | "worker" | "inactive" | "text2" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "success";
  if (line.startsWith("-") && !line.startsWith("---")) return "error";
  if (line.startsWith("@@")) return "worker";
  if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) {
    return "inactive";
  }
  return "text2";
}

function hunkDiffsForFile(file: DiffFileRow): readonly string[] {
  const lines = file.previewLines;
  if (lines.length === 0) return ["No preview available."];
  const header = lines.filter(line =>
    line.startsWith("diff --git") ||
    line.startsWith("---") ||
    line.startsWith("+++"),
  );
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) {
        hunks.push([...header, ...current].join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0 && !line.startsWith("diff --git") && !line.startsWith("---") && !line.startsWith("+++")) {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push([...header, ...current].join("\n"));
  return hunks.length > 0 ? hunks : [lines.join("\n")];
}

function emptyRows(snapshot: DiffMenuSnapshot): readonly DiffFileRow[] {
  if (snapshot.state === "not-repo") {
    return [{
      path: "not a git repository",
      status: "untracked",
      previewLines: ["Run /diff from inside a git work tree."],
    }];
  }
  return [{
    path: "no uncommitted changes",
    status: "changed",
    previewLines: ["Working tree has no tracked diff and no untracked files."],
  }];
}

function DiffMenuView({
  snapshot,
  onDone,
}: {
  readonly snapshot: DiffMenuSnapshot;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = snapshot.files.length > 0 ? snapshot.files : emptyRows(snapshot);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [activeHunkIndex, setActiveHunkIndex] = React.useState(0);
  const [hunkDecisions, setHunkDecisions] = React.useState<Record<string, "accept" | "skip">>({});
  const viewport = useModalOrTerminalSize(useTerminalSize());

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow) {
      setActiveIndex(index => previousMenuIndex(index, rows.length));
      setActiveHunkIndex(0);
      return;
    }
    if (key.downArrow) {
      setActiveIndex(index => nextMenuIndex(index, rows.length));
      setActiveHunkIndex(0);
      return;
    }
    if (input === "k") {
      setActiveHunkIndex(index => Math.max(0, index - 1));
      return;
    }
    if (input === "j") {
      setActiveHunkIndex(index => Math.min(hunkDiffsForFile(selected ?? rows[0]!).length - 1, index + 1));
      return;
    }
    if (input === "y" || input === "n") {
      if (!selected) return;
      setHunkDecisions(prev => ({
        ...prev,
        [`${selected.path}:${activeHunkIndex}`]: input === "y" ? "accept" : "skip",
      }));
    }
  });

  const selected = rows[Math.max(0, Math.min(activeIndex, rows.length - 1))] ?? rows[0];
  const totalAdditions = snapshot.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = snapshot.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const viewportRows = Number.isFinite(viewport.rows)
    ? Math.max(1, Math.trunc(viewport.rows))
    : 24;
  const previewLineBudget = Math.max(3, Math.min(28, viewportRows - 12));
  const previewLines =
    selected?.previewLines.length ? selected.previewLines : ["No preview available."];
  const hunkDiffs = selected ? hunkDiffsForFile(selected) : ["No preview available."];
  const clampedHunkIndex = Math.max(0, Math.min(activeHunkIndex, hunkDiffs.length - 1));
  const selectedHunk = hunkDiffs[clampedHunkIndex] ?? "No preview available.";
  const hunkDecision = selected
    ? hunkDecisions[`${selected.path}:${clampedHunkIndex}`]
    : undefined;
  const visiblePreviewLines = previewLines.slice(0, previewLineBudget);
  const previewClipped = previewLines.length > visiblePreviewLines.length;

  return (
    <MenuModal
      title="diff"
      count={`${snapshot.files.length}`}
      summary={snapshot.state === "changed" ? `+${totalAdditions} -${totalDeletions}` : snapshot.state}
      headerRight={`${snapshot.untrackedFiles.length} untracked · ↑↓ files · j/k hunks`}
      columns={[3, 12, 10, 64]}
      headers={["", "status", "delta", "file"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(item, _index, active) => {
        const color = statusColor(item.status);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(item.status)}
          </ThemedText>,
          <ThemedText key="status" color={color} wrap="truncate-end">
            {item.status}
          </ThemedText>,
          <ThemedText key="delta" color="subtle" wrap="truncate-end">
            {formatDelta(item)}
          </ThemedText>,
          <ThemedText key="file" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {item.path}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc" wrap="truncate-middle">
            {selected?.path ?? "diff"}
          </ThemedText>
          <ThemedText color="subtle" wrap="truncate-end">
            {selected ? `${selected.status} · ${formatDelta(selected)}` : "no selection"}
          </ThemedText>
          <ThemedText color="muted3" wrap="truncate-end">
            hunk {clampedHunkIndex + 1}/{hunkDiffs.length} · {hunkDecision ?? "unmarked"} · y accept · n skip
          </ThemedText>
          {selected ? (
            <EditDiffView
              content={`<edit-file>${selected.path}</edit-file>\n<edit-diff>${selectedHunk}</edit-diff>`}
            />
          ) : null}
          <Box flexDirection="column">
            {visiblePreviewLines.map((line, index) => (
              <ThemedText key={`${index}-${line}`} color={previewColor(line)} wrap="truncate-end">
                {line}
              </ThemedText>
            ))}
            {previewClipped ? (
              <ThemedText color="inactive" wrap="truncate-end">
                ... preview clipped to {previewLineBudget} rows
              </ThemedText>
            ) : null}
          </Box>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "file" },
        { keyName: "j/k", label: "hunk" },
        { keyName: "y", label: "accept hunk" },
        { keyName: "n", label: "skip hunk" },
        { keyName: "q", label: "close" },
      ]}
      hint="git diff HEAD"
    />
  );
}

export function openDiffMenu(
  ctx: SlashCommandContext,
  snapshot: DiffMenuSnapshot,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <DiffMenuView snapshot={snapshot} onDone={close} />
  ));
}
