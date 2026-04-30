// Cherry-picked format helpers for the wholesale-ported search
// dialogs. Self-contained — no transitive deps. Behavior matches
// openclaude src/utils/format.ts byte-for-byte for the functions
// reproduced here (formatRelativeTimeAgo, truncateToWidth,
// truncatePathMiddle).

import { stringWidth } from "../ink/stringWidth.js";

export function formatRelativeTimeAgo(date: Date, opts: { now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 4) return `${diffWeek}w ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffDay / 365);
  return `${diffYr}y ago`;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  const ELLIPSIS = "…";
  const ellipsisW = stringWidth(ELLIPSIS);
  if (maxWidth <= ellipsisW) return ELLIPSIS.slice(0, maxWidth);
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w + ellipsisW > maxWidth) break;
    out += ch;
    width += w;
  }
  return out + ELLIPSIS;
}

export function truncatePathMiddle(path: string, maxWidth: number): string {
  if (stringWidth(path) <= maxWidth) return path;
  const ELLIPSIS = "…";
  const sepIndex = path.lastIndexOf("/");
  if (sepIndex < 0) return truncateToWidth(path, maxWidth);
  const tail = path.slice(sepIndex);
  const tailW = stringWidth(tail);
  if (tailW + 1 >= maxWidth) return truncateToWidth(path, maxWidth);
  const headBudget = maxWidth - tailW - stringWidth(ELLIPSIS);
  let head = "";
  let width = 0;
  for (const ch of path) {
    const w = stringWidth(ch);
    if (width + w > headBudget) break;
    head += ch;
    width += w;
  }
  return head + ELLIPSIS + tail;
}
