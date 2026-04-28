/**
 * Banner placeholder shown in the transcript when friction is detected
 * in a conversation and the user should report an issue.
 *
 * AgenC has no `/issue` flow yet, so this is a no-op renderer that
 * matches the upstream contract and keeps the composer wiring stable.
 * When AgenC ships an issue-reporting flow, this is the seam to
 * surface a banner from.
 */
import * as React from "react";

export function IssueFlagBanner(): React.ReactElement | null {
  return null;
}

export default IssueFlagBanner;
