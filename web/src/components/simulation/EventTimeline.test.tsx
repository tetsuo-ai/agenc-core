import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventTimeline } from "./EventTimeline";
import type { SimulationEvent } from "./useSimulation";

function makeEvent(id: string, step = 1): SimulationEvent {
  return {
    event_id: id,
    type: "action",
    step,
    timestamp: step,
    simulation_id: "sim-1",
    world_id: "world-1",
    workspace_id: "ws-1",
    agent_name: "Marcus",
    content: id,
  };
}

describe("EventTimeline", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockReset();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("scrolls to the bottom when new events arrive and the user is pinned to the bottom", () => {
    const { rerender } = render(<EventTimeline events={[makeEvent("evt-1")]} />);
    const container = screen.getByTestId("simulation-event-timeline-scroll-container");

    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 1000 });

    scrollIntoView.mockClear();
    fireEvent.scroll(container);
    rerender(<EventTimeline events={[makeEvent("evt-1"), makeEvent("evt-2", 2)]} />);

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does not auto-scroll when the user has scrolled away from the bottom", () => {
    const { rerender } = render(<EventTimeline events={[makeEvent("evt-1")]} />);
    const container = screen.getByTestId("simulation-event-timeline-scroll-container");

    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 200 });

    scrollIntoView.mockClear();
    fireEvent.scroll(container);
    rerender(<EventTimeline events={[makeEvent("evt-1"), makeEvent("evt-2", 2)]} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("respects the manual auto-scroll toggle", () => {
    const { rerender } = render(<EventTimeline events={[makeEvent("evt-1")]} />);

    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "[auto-scroll ON]" }));
    rerender(<EventTimeline events={[makeEvent("evt-1"), makeEvent("evt-2", 2)]} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "[auto-scroll OFF]" })).toBeTruthy();
  });
});
