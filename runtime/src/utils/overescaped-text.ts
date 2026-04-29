interface OverescapedScanSummary {
  readonly actualNewlines: number;
  readonly escapedNewlinesOutsideQuotes: number;
  readonly escapedQuotesOutsideQuotes: number;
}

function scanOverescapedText(value: string): OverescapedScanSummary {
  let actualNewlines = 0;
  let escapedNewlinesOutsideQuotes = 0;
  let escapedQuotesOutsideQuotes = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index++) {
    const current = value[index];
    const next = value[index + 1];
    const nextNext = value[index + 2];

    if (!inSingleQuote && current === '"' && value[index - 1] !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inDoubleQuote && current === "'" && value[index - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (current === "\n") {
      actualNewlines++;
      continue;
    }

    if (current !== "\\") continue;

    if (!inSingleQuote && !inDoubleQuote && next === '"' ) {
      escapedQuotesOutsideQuotes++;
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && next === "n") {
      escapedNewlinesOutsideQuotes++;
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && next === "r" && nextNext === "n") {
      escapedNewlinesOutsideQuotes++;
      index += 2;
      continue;
    }

    if ((inSingleQuote || inDoubleQuote) && next !== undefined) {
      index += 1;
    }
  }

  return {
    actualNewlines,
    escapedNewlinesOutsideQuotes,
    escapedQuotesOutsideQuotes,
  };
}

function decodeOneOverescapeLayer(value: string): string {
  let result = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; ) {
    const current = value[index]!;
    if (current !== "\\") {
      result += current;
      if (current === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (current === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      }
      index += 1;
      continue;
    }

    let slashRunEnd = index;
    while (slashRunEnd < value.length && value[slashRunEnd] === "\\") {
      slashRunEnd += 1;
    }
    const slashCount = slashRunEnd - index;
    const next = value[slashRunEnd];
    const nextNext = value[slashRunEnd + 1];
    if (next === undefined) {
      result += "\\".repeat(slashCount);
      break;
    }

    if (next === '"' || next === "'") {
      const decodedSlashCount = Math.max(0, slashCount - 1);
      result += "\\".repeat(decodedSlashCount);
      result += next;
      if (
        decodedSlashCount % 2 === 0 &&
        ((next === '"' && !inSingleQuote) || (next === "'" && !inDoubleQuote))
      ) {
        if (next === '"') {
          inDoubleQuote = !inDoubleQuote;
        } else {
          inSingleQuote = !inSingleQuote;
        }
      }
      index = slashRunEnd + 1;
      continue;
    }

    if (next === "n") {
      const decodedSlashCount = Math.max(0, slashCount - 1);
      if (!inSingleQuote && !inDoubleQuote && decodedSlashCount === 0) {
        result += "\n";
      } else {
        result += "\\".repeat(decodedSlashCount);
        result += "n";
      }
      index = slashRunEnd + 1;
      continue;
    }

    if (next === "t") {
      const decodedSlashCount = Math.max(0, slashCount - 1);
      if (!inSingleQuote && !inDoubleQuote && decodedSlashCount === 0) {
        result += "\t";
      } else {
        result += "\\".repeat(decodedSlashCount);
        result += "t";
      }
      index = slashRunEnd + 1;
      continue;
    }

    if (next === "r" && nextNext === "n") {
      const decodedSlashCount = Math.max(0, slashCount - 1);
      if (!inSingleQuote && !inDoubleQuote && decodedSlashCount === 0) {
        result += "\r\n";
      } else {
        result += "\\".repeat(decodedSlashCount);
        result += "rn";
      }
      index = slashRunEnd + 2;
      continue;
    }

    result += "\\".repeat(slashCount);
    index = slashRunEnd;
  }

  return result;
}

export function normalizeOverescapedToolText(value: string): string {
  if (!value.includes("\\")) return value;

  const summary = scanOverescapedText(value);
  const likelyOverescaped =
    (summary.actualNewlines === 0 &&
      summary.escapedNewlinesOutsideQuotes > 0) ||
    summary.escapedQuotesOutsideQuotes > 0;
  if (!likelyOverescaped) return value;

  const decoded = decodeOneOverescapeLayer(value);
  if (decoded === value) return value;

  const decodedSummary = scanOverescapedText(decoded);
  const improvedMultiline =
    summary.actualNewlines === 0 &&
    summary.escapedNewlinesOutsideQuotes > 0 &&
    decodedSummary.actualNewlines > 0;
  const improvedQuotes =
    summary.escapedQuotesOutsideQuotes > 0 &&
    decodedSummary.escapedQuotesOutsideQuotes < summary.escapedQuotesOutsideQuotes;

  return improvedMultiline || improvedQuotes ? decoded : value;
}
