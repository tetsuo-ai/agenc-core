import { Lexer, type Token, type Tokens } from "marked";

function taskProse(task: string): string {
  const pending: Token[] = Lexer.lex(task, { gfm: true }).reverse();
  const prose: string[] = [];
  while (pending.length > 0) {
    const token = pending.pop()!;
    // Let Markdown determine fence length, marker, indentation and list
    // scope, including unclosed fences. Example text cannot grant an exemption.
    if (token.type === "code" || token.type === "blockquote") continue;
    if (token.type === "list") {
      const items = (token as Tokens.List).items;
      for (let i = items.length - 1; i >= 0; i -= 1) pending.push(items[i]!);
    } else if (token.type === "list_item") {
      const tokens = (token as Tokens.ListItem).tokens;
      for (let i = tokens.length - 1; i >= 0; i -= 1) pending.push(tokens[i]!);
    } else {
      prose.push(token.raw);
    }
  }
  return prose.join("\n");
}

/** Natural-language output contracts used by the completion gate (#2798).
 * Inspect the complete trusted task before truncating its diagnostic quote.
 * This is an exemption from a Markdown review, not a correctness verdict.
 */
export function requestsExactOutput(task: string): boolean {
  // Require a direct affirmative instruction to the assistant. Embedded
  // requirements such as "fix the endpoint to return JSON only" are work to
  // verify, not a contract for the assistant's final response.
  // Mask example contents before splitting clauses, but retain quote markers
  // so direct contracts such as 'return exactly "ok"' still match.
  let unquoted: string;
  try {
    unquoted = taskProse(task);
  } catch {
    // A parse failure must keep completion verification enabled.
    return false;
  }
  const prose = unquoted
    .replace(/`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/gu, '""')
    .split("\n").filter(line => !/^\s*>/u.test(line)).join("\n");
  const clauses = prose.split(/(?:[.!?;]\s+|\n)/u).flatMap(clause => {
    const command = clause.trim().replace(/^(?:please\s+|(?:can|could|will|would)\s+you\s+)/iu, "");
    // Only inherit the assistant as the subject of a coordinated command
    // after a clear assistant action. "Make the endpoint ... and return"
    // keeps the endpoint as its subject and is not a response contract.
    return /^(?:read|inspect|review|analy[sz]e|summarize|run|test|delegate|spawn)\b/iu.test(command)
      ? command.split(/\band\s+/iu)
      : [command];
  });
  return clauses.some(clause => {
    const command = clause.trim().replace(/^(?:please\s+|(?:can|could|will|would)\s+you\s+)/iu, "");
    return /^(?:json|xml|csv|yaml)\s*[- ]?only\s*[.!?]?$/iu.test(command) ||
      /^only\s+(?:valid\s+)?(?:json|xml|csv|yaml)\s*[.!?]?$/iu.test(command) ||
      /^your\s+(?:final\s+)?(?:response|answer|reply)\s+(?:must|should)\s+(?:be|contain)\s+(?:only\s+)?(?:valid\s+)?(?:json|xml|csv|yaml)\b/iu.test(command) ||
      /^(?:respond|reply)\s+(?:in|with)\s+(?:valid\s+)?(?:json|xml|csv|yaml)\b/iu.test(command) ||
      /^(?:return|respond|reply|output|emit)\b[^\n.!?]{0,100}\b(?:only|exactly|nothing\s+but)\b[^\n.!?]{0,80}\b(?:json|xml|csv|yaml)\b/iu.test(command) ||
      /^(?:return|respond|reply|output|emit|copy)\b[^\n.!?]{0,160}\bverbatim\b/iu.test(command) ||
      /^(?:return|respond|reply|output|emit)\s+(?:with\s+)?(?:exactly|only)\s+(?:["'`{\[]|the\s+(?:literal|exact)\s+)/iu.test(command) ||
      /^(?:return|respond|reply|output|emit)\b[^\n.!?]{0,100}\b(?:json|xml|csv|yaml)\b[^\n.!?]{0,80}\b(?:only|without\s+(?:commentary|prose|markdown)|no\s+(?:commentary|prose|markdown))\b/iu.test(command);
  });
}
