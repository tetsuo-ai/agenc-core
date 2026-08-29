/** Exact provider/model result shared by local, deferred, and daemon sessions. */
export interface ProviderModelSelectionOutcome {
  /** Whether the authoritative session accepted or staged the requested pair. */
  readonly applied: boolean;
  /** Exact pair owned by the session after the operation completed. */
  readonly provider: string;
  readonly model: string;
  readonly summary: string;
}
