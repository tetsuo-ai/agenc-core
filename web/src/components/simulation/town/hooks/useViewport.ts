/**
 * Camera state for pan/zoom/follow in the town view.
 */

import { useCallback, useRef, useState } from 'react';

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
  followAgentId: string | null;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

export function useViewport(initialZoom: number = 1) {
  const [state, setState] = useState<ViewportState>({
    x: 0,
    y: 0,
    zoom: initialZoom,
    followAgentId: null,
  });

  const isDragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;

  const pan = useCallback((dx: number, dy: number) => {
    setState((prev) => ({
      ...prev,
      x: prev.x + dx,
      y: prev.y + dy,
      followAgentId: null, // Stop following when user pans manually
    }));
  }, []);

  const zoomTo = useCallback((newZoom: number, centerX?: number, centerY?: number) => {
    setState((prev) => {
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
      if (centerX !== undefined && centerY !== undefined) {
        // Zoom toward pointer position. Guard against zero prev.zoom (should not
        // happen due to MIN_ZOOM clamp, but defensive).
        const prevZoom = prev.zoom || MIN_ZOOM;
        const factor = clamped / prevZoom;
        return {
          ...prev,
          zoom: clamped,
          x: centerX - (centerX - prev.x) * factor,
          y: centerY - (centerY - prev.y) * factor,
        };
      }
      return { ...prev, zoom: clamped };
    });
  }, []);

  const zoomIn = useCallback(() => {
    setState((prev) => ({
      ...prev,
      zoom: Math.min(MAX_ZOOM, prev.zoom + ZOOM_STEP),
    }));
  }, []);

  const zoomOut = useCallback(() => {
    setState((prev) => ({
      ...prev,
      zoom: Math.max(MIN_ZOOM, prev.zoom - ZOOM_STEP),
    }));
  }, []);

  const followAgent = useCallback((agentId: string | null) => {
    setState((prev) => ({ ...prev, followAgentId: agentId }));
  }, []);

  const resetView = useCallback(() => {
    setState({ x: 0, y: 0, zoom: initialZoom, followAgentId: null });
  }, [initialZoom]);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      // Read current zoom from ref to avoid recreating this callback on every zoom change,
      // which would cause the event listener in TownCanvas to churn.
      zoomTo(stateRef.current.zoom + delta, e.clientX, e.clientY);
    },
    [zoomTo],
  );

  const handlePointerDown = useCallback((e: PointerEvent) => {
    isDragging.current = true;
    lastPointer.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      pan(dx, dy);
    },
    [pan],
  );

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return {
    viewport: state,
    pan,
    zoomTo,
    zoomIn,
    zoomOut,
    followAgent,
    resetView,
    handlers: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
  };
}
