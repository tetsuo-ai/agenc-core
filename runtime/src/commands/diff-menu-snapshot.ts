/** Presentation-free git diff snapshots, shared by text and TUI commands. */

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
