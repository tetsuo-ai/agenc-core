import type { LLMToolChoice } from "../llm/types.js";

/** Conservative imperative detection on the active human request only. Never
 * inspect tool results, child messages or retained conversation for authority.
 * Prompt guidance covers more nuanced requests; this forces an initial handoff
 * for unambiguous commands even on providers which otherwise prefer file work.
 */
export function explicitlyRequestsDelegation(text: string): boolean {
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/gu, "")
    .split("\n").filter(line => !/^\s*>/u.test(line)).join("\n");
  const clauses = prose.split(/(?:[.!?;]\s+|\n)/u);
  return clauses.some(clause => {
    const command = clause.trim().replace(/^(?:please\s+|(?:can|could|will|would)\s+you\s+)/iu, "");
    return /^delegate\s+(?:this|the)\s+(?:task|work|request)\b/iu.test(command) ||
      /^(?:use|spawn|launch|ask)\s+(?:(?:exactly|just)\s+)?(?:(?:a|an|the|one|two|three|four|[1-9]|multiple|several)\s+)?(?:[\w-]+\s+){0,2}(?:sub[ -]?agents?|child(?:ren)?|workers?)\b/iu.test(command) ||
      /^(?:delegate|assign)\b[^.!?\n]{0,100}\bto\s+(?:(?:a|an|the|one|multiple)\s+)?(?:sub[ -]?agents?|child|workers?)\b/iu.test(command) ||
      /^(?:call\s+spawn_agent\b|(?:your\s+)?first\s+action\s+(?:must|should)\s+be\s+(?:exactly\s+)?(?:one\s+)?spawn_agent\b)/iu.test(command);
  });
}

export function requiredDelegationToolChoice(input: {
  readonly taskText: string | undefined;
  readonly initialSample: boolean;
  readonly depth: number;
  readonly planMode: boolean;
  readonly toolNames: readonly string[];
}): LLMToolChoice | undefined {
  if (!input.initialSample || input.depth !== 0 || input.planMode ||
      !input.toolNames.includes("spawn_agent") || input.taskText === undefined ||
      !explicitlyRequestsDelegation(input.taskText)) return undefined;
  return { type: "function", name: "spawn_agent" };
}
