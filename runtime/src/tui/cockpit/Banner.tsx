/**
 * Cockpit banner — top-of-TUI status strip.
 *
 * Wave 4-B scope: the full banner. Subscribes (through props) to
 * session + mode registry state surfaced by `AgenCAppStateProvider`
 * and renders a single-row status line shaped like:
 *
 *   [▸ run:abc123] [model:grok-4] [mode:default · press Shift+Tab to cycle]
 *     [phase:stream_model] [tools:2]
 *
 * Visual rules:
 *   - Mode segment uses the palette from `theme.colors.mode*` keyed by
 *     the currently active `PermissionMode`.
 *   - When `hasPlanActive` is truthy a leading `[PLAN]` marker is
 *     prepended in the theme's warning colour. We use the bracket
 *     marker rather than an emoji so terminals without a full emoji
 *     font still show the signal.
 *   - When `isStreaming` is truthy we render a rotating spinner glyph.
 *     The glyph is advanced by subscribing to `useAnimationTick()`
 *     (Wave 2) so the banner re-renders in sync with the Ink clock
 *     rather than owning its own timer.
 *
 * Accessibility / contrast:
 *   - Every segment is bracketed so readers in a monochrome terminal
 *     still see separators.
 *   - The "press Shift+Tab to cycle" hint is dimmed so it does not
 *     compete visually with the mode label itself.
 */

import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { PermissionMode } from "../../permissions/types.js";
import { theme } from "../theme.js";
import { useAnimationTick } from "../hooks/useAnimationTick.js";

export interface BannerProps {
  readonly runId?: string;
  readonly model?: string;
  readonly mode: PermissionMode;
  /** Current execution phase surfaced by session events, e.g. `"stream_model"`. */
  readonly phase?: string;
  readonly activeToolCount?: number;
  readonly isStreaming?: boolean;
  /** Wave 4-C toggles this when plan mode has an active plan artifact. */
  readonly hasPlanActive?: boolean;
}

/**
 * Frame sequence for the streaming spinner. Kept short so the rotation
 * is noticeable even at low tick rates. The frame index is driven off
 * `useAnimationTick().tick` rather than a locally owned counter.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Resolve the palette colour for the active mode. The theme exposes
 * dedicated colour slots per mode so operators can re-skin the palette
 * without touching this file.
 */
function modeColor(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return theme.colors.modeAcceptEdits;
    case "plan":
      return theme.colors.modePlan;
    case "bypassPermissions":
      return theme.colors.modeBypass;
    case "auto":
      return theme.colors.modeAuto;
    case "dontAsk":
      return theme.colors.modeBypass;
    case "bubble":
      return theme.colors.dim;
    case "default":
    default:
      return theme.colors.modeDefault;
  }
}

/**
 * Short form of the run id so the banner stays on one line in narrow
 * terminals. Takes the last 8 characters to match the session-id short
 * form used elsewhere (`String(id).slice(-8)`).
 */
function shortRunId(runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined;
  const trimmed = runId.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= 8) return trimmed;
  return trimmed.slice(-8);
}

/**
 * Tiny helper so each bracketed segment looks consistent without each
 * call site re-implementing the same `[ ... ]` wrapping.
 */
function Segment({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text dim>[</Text>
      {children}
      <Text dim>]</Text>
    </Box>
  );
}

export const Banner: React.FC<BannerProps> = ({
  runId,
  model,
  mode,
  phase,
  activeToolCount,
  isStreaming,
  hasPlanActive,
}) => {
  // Subscribe to the clock so the spinner advances on every frame we
  // receive. The hook returns a sane idle snapshot when no ClockProvider
  // is mounted (e.g. in unit tests), so calling it unconditionally is
  // safe and keeps the hook invocation stable.
  const { tick } = useAnimationTick();
  const indicator = theme.modeIndicatorChar[mode] ?? "›";
  const run = shortRunId(runId);
  const tools = typeof activeToolCount === "number" && activeToolCount > 0
    ? activeToolCount
    : undefined;
  const spinnerFrame = isStreaming
    ? SPINNER_FRAMES[tick % SPINNER_FRAMES.length]
    : undefined;
  const modeAccent = modeColor(mode);

  return (
    <Box borderStyle="single" paddingX={1} flexDirection="row" flexWrap="wrap">
      {hasPlanActive ? (
        <>
          <Text color={theme.colors.warning} bold>
            [PLAN]
          </Text>
          <Text> </Text>
        </>
      ) : null}

      {isStreaming ? (
        <>
          <Text color={theme.colors.primary}>{spinnerFrame ?? SPINNER_FRAMES[0]}</Text>
          <Text> </Text>
        </>
      ) : null}

      <Segment>
        <Text color={modeAccent}>{indicator}</Text>
        {run !== undefined ? (
          <>
            <Text> </Text>
            <Text dim>run:</Text>
            <Text>{run}</Text>
          </>
        ) : (
          <>
            <Text> </Text>
            <Text dim>run:</Text>
            <Text dim>—</Text>
          </>
        )}
      </Segment>
      <Text> </Text>

      <Segment>
        <Text dim>model:</Text>
        <Text>{model ?? "grok"}</Text>
      </Segment>
      <Text> </Text>

      <Segment>
        <Text dim>mode:</Text>
        <Text color={modeAccent} bold>
          {mode}
        </Text>
        <Text dim> · press Shift+Tab to cycle</Text>
      </Segment>
      <Text> </Text>

      {phase !== undefined && phase.length > 0 ? (
        <>
          <Segment>
            <Text dim>phase:</Text>
            <Text>{phase}</Text>
          </Segment>
          <Text> </Text>
        </>
      ) : null}

      {tools !== undefined ? (
        <Segment>
          <Text dim>tools:</Text>
          <Text color={theme.colors.accent}>{String(tools)}</Text>
        </Segment>
      ) : null}
    </Box>
  );
};

export default Banner;
