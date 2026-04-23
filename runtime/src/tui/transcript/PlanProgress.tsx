/**
 * PlanProgress — transcript renderer for plan history cells.
 *
 * Consumes the `plan_started` / `plan_delta` / `plan_item_completed` /
 * `plan_exited` stream and renders a codex-style "Updated Plan" cell with a
 * checklist instead of the older bordered per-item widget.
 *
 * Design notes:
 *   - The component is pure — the caller passes the current event slice
 *     and re-renders on push. No internal buffering means the transcript
 *     stays fully derivable from the event log (I-27/I-49).
 *   - `plan_delta` segments are concatenated in stream order per
 *     `planItemId`. When `plan_item_completed` arrives for a group it
 *     overrides the streamed body with the authoritative `finalText`,
 *     matching the T11-era `agent_message` close-out behavior.
 *   - Events for the same `planItemId` that arrive after completion are
 *     ignored — the rendered body stays pinned to `finalText`.
 *
 * @module
 */

import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";

/** Discriminated plan-event union accepted by `<PlanProgress>`. */
export type PlanEvent =
  | {
      readonly kind: "plan_started";
      readonly planItemId: string;
      readonly title: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "plan_delta";
      readonly planItemId: string;
      readonly delta: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "plan_item_completed";
      readonly planItemId: string;
      readonly finalText: string;
      readonly timestamp: number;
    }
  | { readonly kind: "plan_exited"; readonly timestamp: number };

export interface PlanProgressProps {
  readonly events: ReadonlyArray<PlanEvent>;
}

/** Per-`planItemId` aggregation produced by the reducer below. */
interface PlanItemFrame {
  readonly planItemId: string;
  title: string;
  /** Streamed body (concatenated deltas) until completion arrives. */
  body: string;
  /** Final text after `plan_item_completed` — overrides `body` when set. */
  finalText: string | undefined;
  completed: boolean;
}

/**
 * Fold the raw event stream into one `PlanItemFrame` per `planItemId`,
 * preserving first-seen order. Also records the terminal `plan_exited`
 * marker separately from the item map.
 */
function reduceEvents(events: ReadonlyArray<PlanEvent>): {
  readonly frames: ReadonlyArray<PlanItemFrame>;
  readonly exited: boolean;
  readonly activePlanItemId: string | null;
} {
  const order: string[] = [];
  const map = new Map<string, PlanItemFrame>();
  let exited = false;
  let activePlanItemId: string | null = null;

  for (const ev of events) {
    if (ev.kind === "plan_exited") {
      exited = true;
      activePlanItemId = null;
      continue;
    }
    const existing = map.get(ev.planItemId);
    if (ev.kind === "plan_started") {
      activePlanItemId = ev.planItemId;
      if (!existing) {
        order.push(ev.planItemId);
        map.set(ev.planItemId, {
          planItemId: ev.planItemId,
          title: ev.title,
          body: "",
          finalText: undefined,
          completed: false,
        });
      } else if (existing.title.length === 0) {
        // A delayed `plan_started` that arrives after a delta fills in
        // the header. Deltas that preceded it keep their body.
        existing.title = ev.title;
      }
      continue;
    }
    if (ev.kind === "plan_delta") {
      activePlanItemId = ev.planItemId;
      const frame =
        existing ??
        (() => {
          order.push(ev.planItemId);
          const fresh: PlanItemFrame = {
            planItemId: ev.planItemId,
            title: "",
            body: "",
            finalText: undefined,
            completed: false,
          };
          map.set(ev.planItemId, fresh);
          return fresh;
        })();
      if (!frame.completed) {
        frame.body += ev.delta;
      }
      continue;
    }
    if (ev.kind === "plan_item_completed") {
      activePlanItemId = null;
      const frame =
        existing ??
        (() => {
          order.push(ev.planItemId);
          const fresh: PlanItemFrame = {
            planItemId: ev.planItemId,
            title: "",
            body: "",
            finalText: undefined,
            completed: false,
          };
          map.set(ev.planItemId, fresh);
          return fresh;
        })();
      frame.completed = true;
      frame.finalText = ev.finalText;
      continue;
    }
  }

  const frames: PlanItemFrame[] = [];
  for (const id of order) {
    const f = map.get(id);
    if (f) frames.push(f);
  }
  return { frames, exited, activePlanItemId };
}

function detailText(frame: PlanItemFrame): string {
  const detail = (frame.finalText ?? frame.body).trim();
  if (detail.length === 0) return "";
  if (frame.title.trim().length > 0 && detail === frame.title.trim()) {
    return "";
  }
  return detail;
}

const PlanItemLine: React.FC<{
  readonly frame: PlanItemFrame;
  readonly activePlanItemId: string | null;
  readonly exited: boolean;
}> = ({
  frame,
  activePlanItemId,
  exited,
}) => {
  const summary =
    frame.title.trim() ||
    detailText(frame).split("\n").find((line) => line.trim().length > 0)?.trim() ||
    "(plan step)";
  const detail = detailText(frame);
  const status: "completed" | "in_progress" | "pending" = frame.completed
    ? "completed"
    : !exited && activePlanItemId === frame.planItemId
      ? "in_progress"
      : "pending";
  const icon =
    status === "completed" ? "\u2714" : "\u25A1";
  const color =
    status === "completed"
      ? theme.colors.success
      : status === "in_progress"
        ? theme.colors.primary
        : theme.colors.dim;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dim>{"  \u2514 "}</Text>
        <Text color={color}>{icon}</Text>
        <Text> </Text>
        <Text
          {...(status === "completed"
            ? { dim: true, strikethrough: true }
            : {})}
        >
          {summary}
        </Text>
      </Box>
      {detail.length > 0 && detail !== summary ? (
        <Box flexDirection="column">
          {detail.split("\n").map((line, index) => (
            <Box key={`${frame.planItemId}-detail-${index}`} flexDirection="row">
              <Text dim>{"    "}</Text>
              <Text dim>{line.length > 0 ? line : " "}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

export const PlanProgress: React.FC<PlanProgressProps> = ({ events }) => {
  const { frames, exited, activePlanItemId } = useMemo(
    () => reduceEvents(events),
    [events],
  );

  if (frames.length === 0 && !exited) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dim>{"\u2022 "}</Text>
        <Text bold>Updated Plan</Text>
      </Box>
      {frames.length === 0 ? (
        <Box flexDirection="row">
          <Text dim>{"  \u2514 (no steps provided)"}</Text>
        </Box>
      ) : (
        frames.map((frame) => (
          <PlanItemLine
            key={frame.planItemId}
            frame={frame}
            activePlanItemId={activePlanItemId}
            exited={exited}
          />
        ))
      )}
    </Box>
  );
};

export default PlanProgress;
