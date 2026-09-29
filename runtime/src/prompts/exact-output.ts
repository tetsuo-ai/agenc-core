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
  const prose = task.replace(/```[^]*?```|~~~[^]*?~~~/gu, " ")
    .replace(/`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/gu, '""')
    .split("\n").filter(line => !/^\s*>/u.test(line)).join("\n");
  return prose.split(/(?:[.!?;]\s+|\n|\band\s+)/iu).some(clause => {
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
