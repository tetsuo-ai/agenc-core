export const REALTIME_CONVERSATION_OPEN_TAG = "<realtime_conversation>";
export const REALTIME_CONVERSATION_CLOSE_TAG = "</realtime_conversation>";

export function startsWithRealtimeConversationOpenTag(text: string): boolean {
  const trimmed = text.trimStart();
  const candidate = trimmed.slice(0, REALTIME_CONVERSATION_OPEN_TAG.length);
  return (
    candidate.length >= REALTIME_CONVERSATION_OPEN_TAG.length &&
    candidate.toLowerCase() === REALTIME_CONVERSATION_OPEN_TAG
  );
}
