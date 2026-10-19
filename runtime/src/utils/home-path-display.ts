import { homedir } from "node:os";

/** Presentation only. Never use the result for execution or path authorization. */
export function abbreviateHomePaths(text: string, home = homedir()): string {
  const root = home.replace(/[\\/]+$/u, "");
  // An unset home or a filesystem root must not abbreviate unrelated paths.
  if (!root || /^[A-Za-z]:$/u.test(root)) return text;
  const windows = /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\");
  if (!windows && !text.includes(root)) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = windows ? escaped.replace(/\\\\|\//g, "[\\\\/]") : escaped;
  // Match complete home prefixes in paths, commands, quoted arguments and
  // diagnostics, but not a different user's name or an embedded path suffix.
  return text.replace(
    new RegExp(`(^|[\\s\"'\x60=(:,\\[{>])${pattern}(?=$|[\\\\/\\s\"'\x60),;:\\]}>])`, windows ? "gi" : "g"),
    "$1~",
  );
}
