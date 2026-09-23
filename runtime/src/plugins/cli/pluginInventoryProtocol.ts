/** JSON inventory fields shared by `agenc plugin list --json` and SDK clients. */
export interface AgencPluginInventoryProvenance {
  readonly sourceKind?: "marketplace" | "git" | "local";
  readonly sourceLocation?: string;
  readonly sourceCommit?: string;
  readonly verificationState?: "verified" | "unsigned-local" | "failed";
  readonly publisherKeyId?: string;
  readonly payloadDigest?: string;
  readonly lastRefreshTime?: string;
  readonly updateAvailable?: boolean;
}
