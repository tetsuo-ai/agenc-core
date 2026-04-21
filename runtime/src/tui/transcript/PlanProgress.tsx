/**
 * PlanProgress — transcript renderer for the T12 plan EventMsgs.
 *
 * Scope (T12 Wave 4-C):
 *   - Consumes the `plan_started` / `plan_delta` / `plan_item_completed`
 *     / `plan_exited` events that `src/session/plan-mode.ts` now emits,
 *     groups them by `planItemId`, and renders each group as a single
 *     framed transcript entry.
 *   - `plan_exited` is a terminal marker rendered as a dimmed line
 *     separator so the operator can see plan mode left without waiting
 *     for the next transcript entry.
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
} {
  const order: string[] = [];
  const map = new Map<string, PlanItemFrame>();
  let exited = false;

  for (const ev of events) {
    if (ev.kind === "plan_exited") {
      exited = true;
      continue;
    }
    const existing = map.get(ev.planItemId);
    if (ev.kind === "plan_started") {
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
  return { frames, exited };
}

/** Sigil prefix for the plan header row. */
const PLAN_SIGIL = "\uD83D\uDCCB"; // 📋

/**
 * Render a single plan-item frame as a bordered block with a header,
 * body, and completion footer.
 */
const PlanItemBlock: React.FC<{ readonly frame: PlanItemFrame }> = ({
  frame,
}) => {
  const header =
    frame.title.length > 0 ? `${PLAN_SIGIL} ${frame.title}` : "[PLAN]";
  const body = frame.finalText ?? frame.body;
  return (
    <Box borderStyle="single" paddingX={1} flexDirection="column">
      <Text bold>{header}</Text>
      {body.length > 0 ? <Text>{body}</Text> : null}
      {frame.completed ? <Text color="green">{"\u2713 complete"}</Text> : null}
    </Box>
  );
};

export const PlanProgress: React.FC<PlanProgressProps> = ({ events }) => {
  const { frames, exited } = useMemo(() => reduceEvents(events), [events]);

  if (frames.length === 0 && !exited) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {frames.map((frame) => (
        <PlanItemBlock key={frame.planItemId} frame={frame} />
      ))}
      {exited ? <Text dim>{"— plan mode ended —"}</Text> : null}
    </Box>
  );
};

export default PlanProgress;
