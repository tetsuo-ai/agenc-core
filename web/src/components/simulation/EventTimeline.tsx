/**
 * Scrolling event timeline — real-time simulation events.
 * Phase 4 of CONCORDIA_TODO.MD.
 */

import { useEffect, useRef, useState } from "react";
import type { SimulationEvent } from "./useSimulation";

interface EventTimelineProps {
  events: SimulationEvent[];
}

const EVENT_COLORS: Record<string, string> = {
  observation: "text-blue-400",
  action: "text-yellow-400",
  resolution: "text-green-300",
  step: "text-green-600",
  terminate: "text-red-400",
  collective_emergence: "text-purple-400",
  reflection: "text-cyan-400",
  error: "text-red-500",
};

const EVENT_LABELS: Record<string, string> = {
  observation: "OBS",
  action: "ACT",
  resolution: "RES",
  step: "STP",
  terminate: "END",
  collective_emergence: "COL",
  reflection: "REF",
  error: "ERR",
};

export function EventTimeline({ events }: EventTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);

  const filtered =
    filter === "all"
      ? events
      : events.filter((e) => e.type === filter || e.agent_name === filter);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const uniqueAgents = [...new Set(events.map((e) => e.agent_name).filter(Boolean))];
  const uniqueTypes = [...new Set(events.map((e) => e.type))];

  return (
    <div className="flex flex-col h-full border border-green-800 bg-black font-mono text-xs">
      {/* Filter bar */}
      <div className="flex gap-1 p-1 border-b border-green-900 flex-wrap">
        <button
          onClick={() => setFilter("all")}
          className={`px-1 ${filter === "all" ? "text-green-300 underline" : "text-green-700"}`}
        >
          all
        </button>
        {uniqueTypes.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-1 ${filter === t ? "text-green-300 underline" : "text-green-700"}`}
          >
            {t}
          </button>
        ))}
        <span className="text-green-900">|</span>
        {uniqueAgents.map((a) => (
          <button
            key={a}
            onClick={() => setFilter(a!)}
            className={`px-1 ${filter === a ? "text-green-300 underline" : "text-green-700"}`}
          >
            {a}
          </button>
        ))}
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`ml-auto px-1 ${autoScroll ? "text-green-400" : "text-green-800"}`}
        >
          {autoScroll ? "[auto-scroll ON]" : "[auto-scroll OFF]"}
        </button>
      </div>

      {/* Event list */}
      <div
        ref={containerRef}
        className="flex-1 overflow-x-hidden overflow-y-auto p-1 space-y-0.5"
      >
        {filtered.map((event, i) => (
          <EventCard key={i} event={event} />
        ))}
        {filtered.length === 0 && (
          <div className="text-green-800 p-2">Waiting for events...</div>
        )}
      </div>
    </div>
  );
}

function EventCard({ event }: { event: SimulationEvent }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLORS[event.type] ?? "text-green-600";
  const label = EVENT_LABELS[event.type] ?? event.type.slice(0, 3).toUpperCase();
  const time =
    typeof event.timestamp === "number"
      ? new Date(event.timestamp * 1000).toLocaleTimeString()
      : "--:--:--";
  const content = event.content ?? event.resolved_event ?? "";

  return (
    <div
      className="min-w-0 w-full hover:bg-green-950 cursor-pointer px-1"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="grid w-full grid-cols-[4.5rem_2.5rem_2.75rem_auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
        <span className="text-green-800 w-16 shrink-0">{time}</span>
        <span className={`${color} w-6 shrink-0 font-bold`}>{label}</span>
        <span className="text-green-500 w-4 shrink-0">#{event.step}</span>
        {event.agent_name && (
          <span className="text-green-300 shrink-0">{event.agent_name}:</span>
        )}
        {!event.agent_name && <span className="shrink-0" />}
        <span className="min-w-0 whitespace-pre-wrap break-words text-green-500">
          {content}
        </span>
      </div>
      {expanded && event.resolved_event && event.content !== event.resolved_event && (
        <div className="ml-24 mt-0.5 whitespace-pre-wrap break-words text-green-600">
          Resolved: {event.resolved_event}
        </div>
      )}
      {expanded && event.metadata && (
        <div className="ml-24 mt-0.5 whitespace-pre-wrap break-words text-green-800">
          {JSON.stringify(event.metadata, null, 0).slice(0, 200)}
        </div>
      )}
    </div>
  );
}
