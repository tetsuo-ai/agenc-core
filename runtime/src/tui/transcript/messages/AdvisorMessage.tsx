/**
 * AdvisorMessage — renders an advisor server-tool result row.
 *
 * Adapted from upstream's `components/messages/AdvisorMessage.tsx`.
 *
 * Differences from upstream:
 *   - The advisor is a thin "the runtime called another model to review
 *     this turn" surface. AgenC has no advisor block type yet, so this
 *     row accepts a generic shape carrying the advisor's status, model
 *     name, and either a free-form text result or an error code. The
 *     dispatcher routes here for any future row kind that wants this
 *     visual treatment.
 *   - Upstream pulled `figures.tick` and the `ToolUseLoader` widget;
 *     AgenC uses `glyphs.tick` and a simpler dim-text spinner placeholder.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { glyphs } from "../../design-system/glyphs.js";
import { Spinner } from "../../design-system/Spinner.js";
import { theme } from "../../theme.js";

export type AdvisorMessageState =
  | { readonly status: "running" }
  | { readonly status: "errored"; readonly errorCode: string }
  | { readonly status: "result"; readonly text: string }
  | { readonly status: "redacted_result" };

export interface AdvisorMessageProps {
  readonly state: AdvisorMessageState;
  readonly addMargin?: boolean;
  readonly verbose?: boolean;
  /** Optional model name to print after the "Advising" header. */
  readonly advisorModel?: string;
  readonly shouldAnimate?: boolean;
}

export function AdvisorMessage({
  state,
  addMargin = false,
  verbose = false,
  advisorModel,
  shouldAnimate = true,
}: AdvisorMessageProps): React.ReactElement {
  const marginTop = addMargin ? 1 : 0;

  if (state.status === "running") {
    return (
      <Box marginTop={marginTop} paddingRight={2} flexDirection="row">
        {shouldAnimate ? <Spinner /> : <Text color={theme.colors.dim}>·</Text>}
        <Text bold> Advising</Text>
        {advisorModel ? (
          <Text color={theme.colors.dim}> using {advisorModel}</Text>
        ) : null}
      </Box>
    );
  }

  let body: React.ReactNode;
  if (state.status === "errored") {
    body = (
      <Text color={theme.colors.error}>
        Advisor unavailable ({state.errorCode})
      </Text>
    );
  } else if (state.status === "redacted_result") {
    body = (
      <Text color={theme.colors.dim}>
        {glyphs.tick} Advisor reviewed the conversation and will apply the
        feedback
      </Text>
    );
  } else if (verbose) {
    body = <Text color={theme.colors.dim}>{state.text}</Text>;
  } else {
    body = (
      <Text color={theme.colors.dim}>
        {glyphs.tick} Advisor reviewed the conversation and will apply the
        feedback
      </Text>
    );
  }

  return (
    <Box marginTop={marginTop} paddingRight={2} flexDirection="row">
      {body}
    </Box>
  );
}

export default AdvisorMessage;
