import type { LLMToolChoice } from "../llm/types.js";

/** Conservative imperative detection on the active human request only. Never
 * inspect tool results, child messages or retained conversation for authority.
 * Prompt guidance covers more nuanced requests; this forces an initial handoff
 * for unambiguous commands even on providers which otherwise prefer file work.
 */
export function explicitlyRequestsDelegation(text: string): boolean {
  // Remove quoted spans before splitting sentences, including examples that
  // contain an imperative in their second sentence.
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~|`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/gu, "")
    .split("\n").filter(line => !/^\s*>/u.test(line)).join("\n");
  // Conditions can qualify a handoff across line or sentence boundaries.
  // Let the model resolve their scope instead of forcing the initial tool.
  if (/\b(?:if|unless|after|before|once|when|until|provided|pending)\b/iu.test(prose)) return false;
  // Earlier instructions may be prerequisites. Only an initial command is
  // unambiguous enough to force delegation before any other work.
  const clauses = prose.split(/(?:[.!?;]\s+|\n)/u).filter(clause => clause.trim()).slice(0, 1);
  // A prohibition anywhere in the active request takes precedence over an
  // otherwise affirmative handoff. Quoted examples were removed above.
  if (/\b(?:do\s+not|don['’]t|never)\s+(?:delegate\b|(?:use|spawn|launch|ask|call)\b[^.!?;\n]{0,100}\b(?:sub[ -]?agents?|child(?:ren)?|workers?|spawn_agent)\b)/iu.test(prose) ||
      /\b(?:use|spawn|launch|ask)\s+(?:(?:exactly|just)\s+)?(?:no|zero|0)\s+(?:[\w-]+\s+){0,2}(?:sub[ -]?agents?|child(?:ren)?|workers?)\b/iu.test(prose)) return false;
  return clauses.some(clause => {
    const command = clause.trim().replace(/^(?:please\s+|(?:can|could|will|would)\s+you\s+)/iu, "");
    if (/\b(?:web|service|shared|dedicated|background|application|queue|job)\s+workers?\b/iu.test(command)) return false;
    if (/^(?:use|spawn|launch|ask)\s+(?:(?:exactly|just)\s+)?(?:no|zero|0)\b/iu.test(command)) return false;
    return /^delegate\s+(?:this|the)\s+(?:task|work|request)\b/iu.test(command) ||
      /^(?:use|spawn|launch|ask)\s+(?:(?:exactly|just)\s+)?(?:(?:a|an|the|one|two|three|four|[1-9]|multiple|several)\s+)?(?:[\w-]+\s+){0,2}(?:sub[ -]?agents?|child(?:ren)?(?!\s+(?:process(?:es)?|components?|elements?|nodes?|routes?)\b)|workers?(?!\s+(?:threads?|process(?:es)?|pools?)\b))\b/iu.test(command) ||
      /^(?:delegate|assign)\b[^.!?\n]{0,100}\bto\s+(?:(?:a|an|the|one|multiple)\s+)?(?:sub[ -]?agents?|child(?!\s+(?:process(?:es)?|components?|elements?|nodes?|routes?)\b)|workers?(?!\s+(?:threads?|process(?:es)?|pools?)\b))\b/iu.test(command) ||
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
