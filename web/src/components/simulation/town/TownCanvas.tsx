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

        // Load tileset textures
        const tilesetTextures = new Map<string, Texture>();
        for (const ts of parsedMap.tilesets) {
          try {
            const texture = await Assets.load<Texture>(ts.image);
            tilesetTextures.set(ts.name, texture);
          } catch {
            console.warn(`Failed to load tileset: ${ts.image}`);
          }
        }

        if (destroyed) return;

        // Try to load agent spritesheet
        let agentSpritesheet: Texture | undefined;
        try {
          agentSpritesheet = await Assets.load<Texture>('/assets/sprites/agents/agent-default.png');
        } catch {
          // Falls back to circles
        }

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
          for (const cmd of commandsRef.current) {
            const key = `${cmd.agentName}:${cmd.type}:${cmd.text ?? ''}`;
            if (!processedCommandsRef.current.has(key)) {
              processedCommandsRef.current.add(key);
              if ((cmd.type === 'speech' || cmd.type === 'action') && cmd.text) {
                for (const agent of agentsRef.current) {
                  if (agent.name === cmd.agentName) {
                    agentLayerRef.current?.showSpeech(agent.agentId, cmd.text, cmd.duration);
                    break;
                  }
                }
              }
              if (processedCommandsRef.current.size > 200) {
                const entries = [...processedCommandsRef.current];
                processedCommandsRef.current = new Set(entries.slice(-100));
              }
            }
          }

          // Update relationship overlay
          if (overlayLayerRef.current) {
            const positions = new Map<string, { x: number; y: number }>();
            for (const agent of agentsRef.current) {
              positions.set(agent.agentId, { x: agent.targetX, y: agent.targetY });
            }
            const rels = overlayLayerRef.current.extractRelationships(
              agentsRef.current,
              agentStatesRef.current,
            );
            overlayLayerRef.current.updateRelationships(rels, positions);
          }

          // Report positions
          const positions = new Map<
            string,
            { x: number; y: number; locationId: string | null }
          >();
          for (const agent of agentsRef.current) {
            positions.set(agent.agentId, {
              x: agent.targetX,
              y: agent.targetY,
              locationId: agent.locationId,
            });
          }
          onPositionsUpdateRef.current(positions);
        });
      })
      .catch((err) => {
        if (!destroyed) console.error('PixiJS init failed:', err);
      });

    return () => {
      destroyed = true;
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
