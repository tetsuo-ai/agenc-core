export type SourceLocation = {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
};

export type TestFailure = {
  readonly id: string;
  readonly name: string;
  readonly location?: SourceLocation;
  readonly message: string;
};

const SOURCE_EXTENSION_PATTERN = String.raw`[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp`;
const SOURCE_PATH_PATTERN = String.raw`(?:(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])[^:\r\n]*?|[^\s():\\/\r\n]+[\\/][^:\r\n]*?|[^\s():\\/\r\n]+?)\.(?:${SOURCE_EXTENSION_PATTERN})`;
const SOURCE_LOCATION_PATTERN = new RegExp(
  String.raw`(^|[\s([{"'])(${SOURCE_PATH_PATTERN}):(\d+)(?::(\d+))?(?=$|[\s)\]}",'])`,
  "gu",
);

export function parseSourceLocations(output: string): SourceLocation[] {
  const seen = new Set<string>();
  const locations: SourceLocation[] = [];
  for (const match of output.matchAll(SOURCE_LOCATION_PATTERN)) {
    const file = match[2]!;
    const line = Number.parseInt(match[3]!, 10);
    const columnText = match[4];
    const column = columnText ? Number.parseInt(columnText, 10) : undefined;
    const key = `${file}:${line}:${column ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({
      file,
      line,
      ...(Number.isFinite(column) ? { column } : {}),
    });
  }
  return locations;
}

export function parseVitestFailures(output: string): TestFailure[] {
  const lines = output.split(/\r?\n/u);
  const failures: TestFailure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nameMatch = /^\s*(?:FAIL|\u00d7|\u2715)\s+(.+?)\s*$/u.exec(line);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.trim();
    const following = lines.slice(index + 1, index + 8).join("\n");
    const [location] = parseSourceLocations(following);
    const message =
      lines.slice(index + 1, index + 5).find((item) => item.trim().length > 0)?.trim() ??
      line.trim();
    failures.push({
      id: `${name}:${location?.file ?? index}:${location?.line ?? 0}`,
      name,
      location,
      message,
    });
  }
  return failures;
}
