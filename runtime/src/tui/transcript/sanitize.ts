import { stripTerminalControlSequences } from "../_deps/markdown.js";

function toVisibleControlEscape(codePoint: number): string {
  if (codePoint === 0x1b) {
    return "\\x1b";
  }
  if (codePoint === 0x0d) {
    return "\\r";
  }
  if (codePoint === 0x09) {
    return "\t";
  }
  if (codePoint >= 0x00 && codePoint <= 0xff) {
    return `\\x${codePoint.toString(16).padStart(2, "0")}`;
  }
  return `\\u{${codePoint.toString(16)}}`;
}

export function sanitizeTranscriptText(value: string): string {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return stripTerminalControlSequences(normalized);
}

export function neutralizeControlCharsForDisplay(value: string): string {
  const source = String(value ?? "");
  let output = "";
  for (let index = 0; index < source.length; ) {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const width = codePoint > 0xffff ? 2 : 1;
    if (
      codePoint === 0x0a ||
      (codePoint >= 0x20 && codePoint !== 0x7f)
    ) {
      output += source.slice(index, index + width);
    } else {
      output += toVisibleControlEscape(codePoint);
    }
    index += width;
  }
  return output;
}
