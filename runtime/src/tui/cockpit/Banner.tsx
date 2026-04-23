/**
 * Cockpit banner — top-of-TUI control rail.
 *
 * Wave 4-B scope: the full banner. Subscribes (through props) to
 * session + mode registry state surfaced by `AgenCAppStateProvider`
 * and renders a denser cockpit header with:
 *
 *   - a leading live/ready status signal
 *   - high-visibility mode + model chips
 *   - compact secondary telemetry (plan, phase, tools, run id)
 *   - a compressed mode-cycle hint instead of a full sentence
 *
 * The visual hierarchy intentionally borrows from the denser Codex /
 * OpenClaude footer patterns, but keeps AgenC's watch palette and
 * chrome so the surface still feels native to this runtime.
 */

import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { getSpinnerFrame } from "../components/Spinner.js";
import type { Color } from "../ink/styles.js";
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
 * Resolve the palette colour for the active mode. The theme exposes
 * dedicated colour slots per mode so operators can re-skin the palette
 * without touching this file.
 */
function modeColor(mode: PermissionMode): Color {
  switch (mode) {
    case "acceptEdits":
      return theme.colors.modeAcceptEdits as Color;
    case "plan":
      return theme.colors.modePlan as Color;
    case "bypassPermissions":
      return theme.colors.modeBypass as Color;
    case "auto":
      return theme.colors.modeAuto as Color;
    case "dontAsk":
      return theme.colors.modeBypass as Color;
    case "bubble":
      return theme.colors.dim as Color;
    case "default":
    default:
      return theme.colors.modeDefault as Color;
  }
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "accept";
    case "bypassPermissions":
      return "bypass";
    case "dontAsk":
      return "silent";
    default:
      return mode;
  }
}

function phaseColor(phase: string | undefined): Color {
  if (typeof phase !== "string" || phase.length === 0) {
    return theme.colors.muted as Color;
  }
  const normalized = phase.toLowerCase();
  if (/(error|fail|blocked|cancel)/.test(normalized)) return theme.colors.error as Color;
  if (/(tool|exec)/.test(normalized)) return theme.colors.accent as Color;
  if (/plan/.test(normalized)) return theme.colors.modePlan as Color;
  if (/(stream|model|token)/.test(normalized)) return theme.colors.primary as Color;
  return theme.colors.info as Color;
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

function Chip({
  label,
  value,
  valueColor = theme.colors.ink as Color,
  compact = false,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly valueColor?: Color;
  readonly compact?: boolean;
}): React.ReactElement {
  const labelText = compact ? label : label.toUpperCase();
  return (
    <Box flexDirection="row" marginRight={1}>
      <Text
        backgroundColor={theme.colors.surface as Color}
        color={theme.colors.muted as Color}
      >
        {` ${labelText} `}
      </Text>
      <Text
        backgroundColor={theme.colors.surfaceAlt as Color}
        color={valueColor}
        bold
        wrap="truncate"
      >
        {" "}
        {value}
        {" "}
      </Text>
    </Box>
  );
}

function LeadStatus({
  isStreaming,
  spinnerFrame,
  phase,
}: {
  readonly isStreaming?: boolean;
  readonly spinnerFrame?: string;
  readonly phase?: string;
}): React.ReactElement {
  const liveColor = (isStreaming ? theme.colors.primary : theme.colors.muted) as Color;
  const liveLabel = isStreaming ? "LIVE" : "READY";
  const glyph = isStreaming ? (spinnerFrame ?? getSpinnerFrame(0)) : "•";

  return (
    <Box flexDirection="row" alignItems="center" marginRight={1}>
      <Text color={liveColor}>{glyph}</Text>
      <Text> </Text>
      <Text color={theme.colors.ink as Color} bold>
        {liveLabel}
      </Text>
      {phase !== undefined && phase.length > 0 ? (
        <>
          <Text color={theme.colors.dim as Color}> / </Text>
          <Text color={phaseColor(phase)}>{phase}</Text>
        </>
      ) : null}
    </Box>
  );
}

function Segment({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="row" alignItems="center" marginRight={1}>
      {children}
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
    ? getSpinnerFrame(tick)
    : undefined;
  const modeAccent = modeColor(mode);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.lineStrong as Color}
      borderText={{ content: " AgenC cockpit ", position: "top", align: "start", offset: 1 }}
      paddingX={1}
      flexDirection="row"
      flexWrap="wrap"
      width="100%"
    >
      <LeadStatus
        isStreaming={isStreaming}
        spinnerFrame={spinnerFrame}
        phase={phase}
      />

      {hasPlanActive ? (
        <Chip
          label="plan"
          value="ready"
          valueColor={theme.colors.warning as Color}
        />
      ) : null}

      <Chip
        label="mode"
        value={`${indicator} ${modeLabel(mode)}`}
        valueColor={modeAccent}
      />

      <Chip
        label="model"
        value={model ?? "grok"}
        valueColor={theme.colors.ink as Color}
      />

      {tools !== undefined ? (
        <Chip
          label="tools"
          value={String(tools)}
          valueColor={theme.colors.accent as Color}
          compact
        />
      ) : null}

      {run !== undefined ? (
        <Chip
          label="run"
          value={run}
          valueColor={theme.colors.secondary as Color}
          compact
        />
      ) : null}

      <Segment>
        <Text color={theme.colors.dim as Color}>⇧Tab</Text>
        <Text color={theme.colors.muted as Color}> cycle</Text>
      </Segment>
    </Box>
  );
};

export default Banner;
