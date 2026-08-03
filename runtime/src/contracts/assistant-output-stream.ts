/** Optional bounded sink for canonical, user-visible assistant output. */

export interface AssistantOutputStreamSink {
  /** Reset output at the start of a sampling attempt or provider reset. */
  reset(): void;
  /**
   * Append one canonical assistant-output delta after hidden-channel,
   * citation, plan, and spoof filtering. Implementations apply backpressure.
   */
  writeCanonicalDelta(delta: string): void;
}
