/** Active shell substitutions, retaining the code inside them for write analysis. */
export function readShellSubstitutions(source: string): {
  readonly commands: readonly string[];
  readonly complete: boolean;
} {
  const text = source.replace(/\\\n/g, "");
  const commands: string[] = [];
  let complete = !text.includes("<<"); // Heredoc expansion needs its own quoting rules.

  function endOfBacktick(start: number): number {
    for (let at = start + 1; at < text.length; at += 1) {
      if (text[at] === "\\") { complete = false; at += 1; }
      else if (text[at] === "`") return at;
    }
    complete = false;
    return text.length;
  }
  function endOfGroup(start: number): number {
    let depth = 1;
    let quote: "'" | '"' | undefined;
    for (let at = start + 2; at < text.length; at += 1) {
      const char = text[at];
      if (quote === "'") { if (char === "'") quote = undefined; continue; }
      if (char === "\\") { at += 1; continue; }
      if (char === "`") { at = endOfBacktick(at); continue; }
      if (char === "$" && text[at + 1] === "(") { at = endOfGroup(at); continue; }
      if (char === '"') { quote = quote === '"' ? undefined : '"'; continue; }
      if (quote !== undefined) continue;
      if (char === "'") { quote = "'"; continue; }
      if (char === "(") depth += 1;
      if (char === ")" && --depth === 0) return at;
    }
    complete = false;
    return text.length;
  }

  let quote: "'" | '"' | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote === "'") { if (char === "'") quote = undefined; continue; }
    if (char === "\\") { at += 1; continue; }
    if (char === '"') { quote = quote === '"' ? undefined : '"'; continue; }
    if (quote === undefined && char === "'") { quote = "'"; continue; }
    if (quote === undefined && char === "#" && (at === 0 || /[\s;|&()]/u.test(text[at - 1]!))) {
      const end = text.indexOf("\n", at); at = end < 0 ? text.length : end; continue;
    }
    if (char === "`") {
      const end = endOfBacktick(at); commands.push(text.slice(at + 1, end)); at = end; continue;
    }
    if ((char === "$" || (quote === undefined && (char === "<" || char === ">"))) && text[at + 1] === "(") {
      const end = endOfGroup(at);
      const body = text.slice(at + 2, end);
      // A literal arithmetic expression runs no command. Variable arithmetic
      // and arithmetic containing a substitution retain the conservative path.
      if (char === "$" && body.startsWith("(") && body.endsWith(")") && /^[\d\s()+*/%&|^~!?:<>=.\-]+$/u.test(body)) {
        commands.push(":");
      } else commands.push(body);
      at = end;
    }
  }
  return { commands, complete };
}
