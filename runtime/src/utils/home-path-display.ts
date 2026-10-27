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

/** Hold a possible HOME prefix until a later chunk can disambiguate it. */
export function abbreviateStreamingHomePaths(text: string, home = homedir()): string {
  const root = home.replace(/[\\/]+$/u, "");
  if (!root || /^[A-Za-z]:$/u.test(root)) return text;
  const windows = /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\");
  const normalize = (value: string) => windows
    ? value.replace(/\\/g, "/").toLowerCase()
    : value;
  const normalizedRoot = normalize(root);
  for (let length = Math.min(root.length - 1, text.length); length > 0; length--) {
    const start = text.length - length;
    if (start > 0 && !/[\s"'`=(:,\[{>]/u.test(text[start - 1]!)) continue;
    if (normalize(text.slice(start)) === normalizedRoot.slice(0, length)) {
      return abbreviateHomePaths(text.slice(0, start), home);
    }
  }
  return abbreviateHomePaths(text, home);
}
