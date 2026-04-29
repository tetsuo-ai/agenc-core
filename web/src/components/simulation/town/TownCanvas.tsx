/**
 * PixiJS Application wrapper using imperative useEffect pattern.
 * Manages WebGL context lifecycle — destroys on unmount to prevent leaks.
 * Phase 3: viewport pan/zoom, object layer, overlay layer, time-of-day filter.
 */

import { useEffect, useRef } from 'react';
import { Application, Assets, Container, Texture, ColorMatrixFilter } from 'pixi.js';
import type { ParsedMap } from './maps/types';
import { createTilemapContainer } from './layers/TilemapLayer';
import { AgentLayerManager } from './layers/AgentLayer';
import { OverlayLayerManager } from './layers/OverlayLayer';
import type { AgentVisualState } from './hooks/useTownState';
import type { ViewportState } from './hooks/useViewport';
import type { VisualCommand } from './systems/EventInterpreter';
import type { AgentState } from '../useSimulation';

const ASSET_LOAD_TIMEOUT_MS = 8_000;
const POSITION_REPORT_INTERVAL = 10; // frames between position reports (skip most frames)

/**
 * Map an agent's last action string to a simple activity emoji.
 * Returns null when there is no action (hides the indicator).
 */
function actionToEmoji(action: string | null | undefined): string | null {
  if (!action) return null;
  const lower = action.toLowerCase();
  if (/\b(speak|talk|say)\b/.test(lower)) return '\uD83D\uDCAC'; // speech balloon
  if (/\b(walk|move|go)\b/.test(lower)) return '\uD83D\uDC63'; // footprints
  if (/\b(read|write|study)\b/.test(lower)) return '\uD83D\uDCDA'; // books
  if (/\b(eat|drink|cook)\b/.test(lower)) return '\uD83C\uDF7D\uFE0F'; // fork and knife with plate
  if (/\b(trade|buy|sell)\b/.test(lower)) return '\uD83D\uDCB0'; // money bag
  return '\u2699\uFE0F'; // gear
}

interface TownCanvasProps {
  parsedMap: ParsedMap | null;
  agents: AgentVisualState[];
  agentStates: Record<string, AgentState>;
  commands: VisualCommand[];
  viewport: ViewportState;
  timeOfDay?: string | null;
  onAgentPositionsUpdate: (
    positions: Map<string, { x: number; y: number; locationId: string | null }>,
  ) => void;
  onAgentClick?: (agentId: string) => void;
  onWheel?: (e: WheelEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerMove?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
}

export function TownCanvas({
  parsedMap,
  agents,
  agentStates,
  commands,
  viewport,
  timeOfDay,
  onAgentPositionsUpdate,
  onAgentClick,
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: TownCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldContainerRef = useRef<Container | null>(null);
  const agentLayerRef = useRef<AgentLayerManager | null>(null);
  const overlayLayerRef = useRef<OverlayLayerManager | null>(null);
  const agentsRef = useRef<AgentVisualState[]>(agents);
  const agentStatesRef = useRef<Record<string, AgentState>>(agentStates);
  const commandsRef = useRef<VisualCommand[]>(commands);
  const viewportRef = useRef<ViewportState>(viewport);
  const onPositionsUpdateRef = useRef(onAgentPositionsUpdate);
  const onAgentClickRef = useRef(onAgentClick);
  const processedCommandsRef = useRef(new Set<string>());
  const timeFilterRef = useRef<ColorMatrixFilter | null>(null);

  agentsRef.current = agents;
  agentStatesRef.current = agentStates;
  commandsRef.current = commands;
  viewportRef.current = viewport;
  onPositionsUpdateRef.current = onAgentPositionsUpdate;
  onAgentClickRef.current = onAgentClick;

  // Apply viewport transforms
  useEffect(() => {
    const world = worldContainerRef.current;
    if (!world) return;
    world.x = viewport.x;
    world.y = viewport.y;
    world.scale.set(viewport.zoom);
  }, [viewport.x, viewport.y, viewport.zoom]);

  // Apply time-of-day color filter
  useEffect(() => {
    const filter = timeFilterRef.current;
    if (!filter) return;

    applyTimeOfDayFilter(filter, timeOfDay ?? null);
  }, [timeOfDay]);

  // Wire up pointer/wheel events on the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handlers: Array<[string, (e: Event) => void]> = [];

    if (onWheel) {
      const h = (e: Event) => onWheel(e as WheelEvent);
      canvas.addEventListener('wheel', h, { passive: false });
      handlers.push(['wheel', h]);
    }
    if (onPointerDown) {
      const h = (e: Event) => onPointerDown(e as PointerEvent);
      canvas.addEventListener('pointerdown', h);
      handlers.push(['pointerdown', h]);
    }
    if (onPointerMove) {
      const h = (e: Event) => onPointerMove(e as PointerEvent);
      canvas.addEventListener('pointermove', h);
      handlers.push(['pointermove', h]);
    }
    if (onPointerUp) {
      const h = (e: Event) => onPointerUp(e as PointerEvent);
      canvas.addEventListener('pointerup', h);
      handlers.push(['pointerup', h]);
    }

    return () => {
      for (const [type, h] of handlers) {
        canvas.removeEventListener(type, h);
      }
    };
  }, [onWheel, onPointerDown, onPointerMove, onPointerUp]);

  useEffect(() => {
    if (!canvasRef.current || !parsedMap) return;

    const canvas = canvasRef.current;
    const app = new Application();
    let destroyed = false;
    const abortController = new AbortController();
    let frameCounter = 0;

    // Reusable maps to avoid per-frame allocations
    const overlayPositions = new Map<string, { x: number; y: number }>();
    const reportPositions = new Map<string, { x: number; y: number; locationId: string | null }>();

    app
      .init({
        canvas,
        width: parsedMap.pixelWidth,
        height: parsedMap.pixelHeight,
        backgroundColor: 0x1a1a2e,
        antialias: false,
        resolution: 1,
        autoDensity: true,
      })
      .then(async () => {
        if (destroyed) return;
        appRef.current = app;

        // World container for pan/zoom
        const worldContainer = new Container();
        worldContainer.label = 'world';
        worldContainerRef.current = worldContainer;
        app.stage.addChild(worldContainer);

        // Time-of-day color filter
        const timeFilter = new ColorMatrixFilter();
        timeFilterRef.current = timeFilter;
        worldContainer.filters = [timeFilter];

        // Load tileset textures with timeout and abort support
        const tilesetTextures = new Map<string, Texture>();
        for (const ts of parsedMap.tilesets) {
          if (destroyed) break;
          try {
            // Pre-check the asset exists before handing to PixiJS Assets loader
            // (PixiJS can hang on non-image 404 responses)
            const probe = await fetch(ts.image, {
              method: 'HEAD',
              signal: abortController.signal,
            });
            if (!probe.ok || !probe.headers.get('content-type')?.startsWith('image/')) {
              console.warn(`Tileset unavailable (${probe.status}): ${ts.image}`);
              continue;
            }

            // Wrap Assets.load with a timeout to prevent indefinite hangs
            const texture = await Promise.race([
              Assets.load<Texture>(ts.image),
              new Promise<never>((_, reject) => {
                const id = setTimeout(
                  () => reject(new Error(`Tileset load timeout: ${ts.image}`)),
                  ASSET_LOAD_TIMEOUT_MS,
                );
                abortController.signal.addEventListener('abort', () => {
                  clearTimeout(id);
                  reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
              }),
            ]);
            tilesetTextures.set(ts.name, texture);
          } catch (err) {
            if (abortController.signal.aborted) break;
            console.warn(`Failed to load tileset: ${ts.image}`, err);
          }
        }

        if (destroyed) return;

        // Agent spritesheet not yet available — use circle fallback
        const agentSpritesheet: Texture | undefined = undefined;

        if (destroyed) return;

        // Create tilemap layer
        const tilemapContainer = createTilemapContainer(parsedMap, tilesetTextures);
        worldContainer.addChild(tilemapContainer);

        // Create overlay layer (relationship lines — behind agents)
        const overlayLayer = new OverlayLayerManager();
        overlayLayerRef.current = overlayLayer;
        worldContainer.addChild(overlayLayer.container);

        // Create agent layer
        const agentLayer = new AgentLayerManager(agentSpritesheet);
        agentLayerRef.current = agentLayer;
        agentLayer.setOnAgentClick((agentId) => {
          onAgentClickRef.current?.(agentId);
        });
        worldContainer.addChild(agentLayer.container);

        // Apply initial viewport
        fitToViewport(app, parsedMap);

        // Animation tick
        app.ticker.add((ticker) => {
          if (destroyed) return;

          // Update agents
          agentLayerRef.current?.update(agentsRef.current, ticker.deltaTime);

          // Process speech bubble commands
          const cmds = commandsRef.current;
          for (let i = 0; i < cmds.length; i++) {
            const cmd = cmds[i];
            const key = `${cmd.agentName}:${cmd.type}:${cmd.text ?? ''}`;
            if (!processedCommandsRef.current.has(key)) {
              processedCommandsRef.current.add(key);
              if ((cmd.type === 'speech' || cmd.type === 'action') && cmd.text) {
                const agents = agentsRef.current;
                for (let j = 0; j < agents.length; j++) {
                  if (agents[j].name === cmd.agentName) {
                    agentLayerRef.current?.showSpeech(agents[j].agentId, cmd.text, cmd.duration);
                    break;
                  }
                }
              }
              // Cap processed commands to prevent unbounded growth.
              // Use a simple clear instead of spread+slice to avoid GC churn in the render loop.
              if (processedCommandsRef.current.size > 500) {
                processedCommandsRef.current.clear();
              }
            }
          }

          // Update activity emoji per agent based on lastAction
          if (agentLayerRef.current) {
            const states = agentStatesRef.current;
            const agentList = agentsRef.current;
            for (let i = 0; i < agentList.length; i++) {
              const agentState = states[agentList[i].agentId];
              const emoji = actionToEmoji(agentState?.lastAction);
              agentLayerRef.current.setActivity(agentList[i].agentId, emoji);
            }
          }

          // Update relationship overlay (every frame for smooth line following)
          if (overlayLayerRef.current) {
            overlayPositions.clear();
            const agents = agentsRef.current;
            for (let i = 0; i < agents.length; i++) {
              overlayPositions.set(agents[i].agentId, {
                x: agents[i].targetX,
                y: agents[i].targetY,
              });
            }
            const rels = overlayLayerRef.current.extractRelationships(
              agents,
              agentStatesRef.current,
            );
            overlayLayerRef.current.updateRelationships(rels, overlayPositions);
          }

          // Report positions (throttled — no need to update React state at 60fps)
          frameCounter++;
          if (frameCounter >= POSITION_REPORT_INTERVAL) {
            frameCounter = 0;
            reportPositions.clear();
            const agents = agentsRef.current;
            for (let i = 0; i < agents.length; i++) {
              reportPositions.set(agents[i].agentId, {
                x: agents[i].currentX,
                y: agents[i].currentY,
                locationId: agents[i].locationId,
              });
            }
            onPositionsUpdateRef.current(reportPositions);
          }
        });
      })
      .catch((err) => {
        if (!destroyed) console.error('PixiJS init failed:', err);
      });

    return () => {
      destroyed = true;
      abortController.abort();
      agentLayerRef.current?.destroy();
      agentLayerRef.current = null;
      overlayLayerRef.current?.destroy();
      overlayLayerRef.current = null;
      worldContainerRef.current = null;
      timeFilterRef.current = null;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, [parsedMap]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', imageRendering: 'pixelated', cursor: 'grab' }}
    />
  );
}

function fitToViewport(app: Application, parsed: ParsedMap): void {
  const parent = app.canvas.parentElement;
  if (!parent) return;

  // Guard against zero-size maps or zero-size containers
  if (parsed.pixelWidth <= 0 || parsed.pixelHeight <= 0) return;
  if (parent.clientWidth <= 0 || parent.clientHeight <= 0) return;

  const scaleX = parent.clientWidth / parsed.pixelWidth;
  const scaleY = parent.clientHeight / parsed.pixelHeight;
  const scale = Math.min(scaleX, scaleY, 2);

  const world = app.stage.getChildByLabel('world');
  if (world) {
    world.scale.set(scale);
    world.x = (parent.clientWidth - parsed.pixelWidth * scale) / 2;
    world.y = (parent.clientHeight - parsed.pixelHeight * scale) / 2;
  }

  app.renderer.resize(parent.clientWidth, parent.clientHeight);
}

function applyTimeOfDayFilter(
  filter: ColorMatrixFilter,
  timeOfDay: string | null,
): void {
  filter.reset();

  switch (timeOfDay) {
    case 'dawn':
      filter.brightness(1.05, false);
      // Warm orange tint
      filter.matrix[0] = 1.1;
      filter.matrix[6] = 1.0;
      filter.matrix[12] = 0.85;
      break;
    case 'morning':
      filter.brightness(1.1, false);
      break;
    case 'afternoon':
      // Warm daylight
      filter.brightness(1.05, false);
      filter.matrix[0] = 1.05;
      filter.matrix[12] = 0.95;
      break;
    case 'dusk':
    case 'evening':
      filter.brightness(0.85, false);
      // Purple-orange tint
      filter.matrix[0] = 1.1;
      filter.matrix[6] = 0.85;
      filter.matrix[12] = 1.1;
      break;
    case 'night':
      filter.brightness(0.6, false);
      // Blue tint
      filter.matrix[0] = 0.7;
      filter.matrix[6] = 0.75;
      filter.matrix[12] = 1.2;
      break;
    default:
      // No filter for unknown/null time
      break;
  }
}
