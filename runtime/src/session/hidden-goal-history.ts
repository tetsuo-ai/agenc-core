/** Goal continuations are durable model context, not submitted user prompts. */
export function isHiddenGoalContinuation(message: {
  readonly role?: string;
  readonly content?: unknown;
  readonly id?: string;
  readonly runtimeOnly?: {
    readonly userMessageId?: string;
    readonly responseItemId?: string;
  };
}): boolean {
  // A real submission may contain the literal tag. Its durable identity keeps
  // it selectable; only the anonymous control row emitted by goal-gate is hidden.
  if (
    message.role !== "user" ||
    message.id !== undefined ||
    message.runtimeOnly?.userMessageId !== undefined ||
    message.runtimeOnly?.responseItemId !== undefined
  ) return false;
  return typeof message.content === "string" &&
    /^<goal_gate round="\d+" of="\d+">\n/.test(message.content) &&
    message.content.endsWith("</goal_gate>");
}
