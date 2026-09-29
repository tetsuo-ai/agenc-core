/** Natural-language output contracts used by the completion gate (#2798).
 * Inspect the complete trusted task before truncating its diagnostic quote.
 * This is an exemption from a Markdown review, not a correctness verdict.
 */
export function requestsExactOutput(task: string): boolean {
  return /(?<![\w.])(?:json|xml|csv|yaml)\s*[- ]?only\b/iu.test(task) ||
    /(?:^|[.!?]\s+)only\s+(?:valid\s+)?(?:json|xml|csv|yaml)(?=\s*(?:[.!?\r\n]|$))/iu.test(task) ||
    /\b(?:respond|reply)\s+(?:in|with)\s+(?:valid\s+)?(?:json|xml|csv|yaml)\b/iu.test(task) ||
    /\b(?:return|respond|reply|output|emit)\b[^\n.!?]{0,100}\b(?:only|exactly|nothing\s+but)\b[^\n.!?]{0,80}\b(?:json|xml|csv|yaml)\b/iu.test(task) ||
    /\b(?:return|respond|reply|output|emit|copy)\b[^\n.!?]{0,160}\bverbatim\b/iu.test(task) ||
    /\b(?:return|respond|reply|output|emit)\s+(?:with\s+)?(?:exactly|only)\s+(?:["'`{\[]|the\s+(?:literal|exact)\s+)/iu.test(task) ||
    /\b(?:return|respond|reply|output|emit)\b[^\n.!?]{0,100}\b(?:json|xml|csv|yaml)\b[^\n.!?]{0,80}\b(?:only|without\s+(?:commentary|prose|markdown)|no\s+(?:commentary|prose|markdown))\b/iu.test(task);
}
