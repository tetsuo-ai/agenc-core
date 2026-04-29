/**
 * Agent layer: manages AgentSprite instances.
 * Phase 2: animated sprites with speech bubbles and click handling.
 * Uses imperative PixiJS API.
 */

import { Container, Texture } from 'pixi.js';
import { AgentSpriteDisplay } from '../sprites/AgentSprite';
import type { AgentVisualState } from '../hooks/useTownState';
import type { VisualCommand } from '../systems/EventInterpreter';

interface AgentEntry {
  display: AgentSpriteDisplay;
  agentId: string;
}

export class AgentLayerManager {
  readonly container: Container;
  private agents = new Map<string, AgentEntry>();
  private lerpProgress = new Map<string, number>();
  private movementDirections = new Map<string, { dx: number; dy: number }>();
  private spritesheet: Texture | null = null;
  private onAgentClick: ((agentId: string) => void) | null = null;

  constructor(spritesheet?: Texture) {
    this.container = new Container();
    this.container.label = 'agents';
    this.spritesheet = spritesheet ?? null;
  }

  setOnAgentClick(handler: (agentId: string) => void): void {
    this.onAgentClick = handler;
  }

  update(agentStates: AgentVisualState[], delta: number): void {
    const activeIds = new Set<string>();

    for (const state of agentStates) {
      activeIds.add(state.agentId);

      let entry = this.agents.get(state.agentId);
      if (!entry) {
        entry = this.createAgent(state);
        this.agents.set(state.agentId, entry);
        this.container.addChild(entry.display.container);
      }

      this.updateAgent(entry, state, delta);
    }

    // Remove agents no longer present
    for (const [id, entry] of this.agents) {
      if (!activeIds.has(id)) {
        this.container.removeChild(entry.display.container);
        entry.display.destroy();
        this.agents.delete(id);
        this.lerpProgress.delete(id);
        this.movementDirections.delete(id);
      }
    }

    // Bubble stacking pass: prevent overlapping speech bubbles
    this.stackBubbles();
  }

  applyCommands(commands: VisualCommand[]): void {
    for (const cmd of commands) {
      // Find agent by name
      for (const entry of this.agents.values()) {
        // Match by checking the visual state name
        if (cmd.type === 'speech' || cmd.type === 'action') {
          if (cmd.text) {
            entry.display.showSpeech(cmd.text, cmd.duration);
          }
        }
      }
    }
  }

  showSpeech(agentId: string, text: string, durationMs?: number): void {
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.display.showSpeech(text, durationMs);
    }
  }

  setActivity(agentId: string, emoji: string | null): void {
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.display.setActivity(emoji);
    }
  }

  private stackBubbles(): void {
    // Collect agents with active speech bubbles and their world positions
    const activeBubbles: Array<{
      agentId: string;
      worldX: number;
      worldY: number;
      bubbleWidth: number;
      bubbleHeight: number;
      display: AgentSpriteDisplay;
    }> = [];

    for (const entry of this.agents.values()) {
      const bubble = entry.display.getSpeechBubble();
      if (!bubble.isActive()) {
        // Reset offset for inactive bubbles
        bubble.applyStackOffset(0);
        continue;
      }
      const container = entry.display.container;
      activeBubbles.push({
        agentId: entry.agentId,
        worldX: container.x,
        worldY: container.y,
        bubbleWidth: bubble.getWidth(),
        bubbleHeight: bubble.getHeight(),
        display: entry.display,
      });
    }

    if (activeBubbles.length < 2) {
      // No overlap possible with 0 or 1 active bubble; reset offsets
      for (const ab of activeBubbles) {
        ab.display.getSpeechBubble().applyStackOffset(0);
      }
      return;
    }

    // Sort by Y position (top to bottom)
    activeBubbles.sort((a, b) => a.worldY - b.worldY);

    // Track cumulative offset per bubble (index-keyed)
    const offsets = new Float64Array(activeBubbles.length);

    for (let i = 0; i < activeBubbles.length; i++) {
      for (let j = i + 1; j < activeBubbles.length; j++) {
        const a = activeBubbles[i];
        const b = activeBubbles[j];

        // Check horizontal overlap: are the two agents close enough in X?
        const maxBubbleW = Math.max(a.bubbleWidth, b.bubbleWidth);
        const xDist = Math.abs(a.worldX - b.worldX);
        if (xDist > maxBubbleW) continue;

        // Check vertical overlap of the bubble regions
        // Bubble top = worldY + bubbleBaseY + offset (negative = above)
        const aTop = a.worldY - a.bubbleHeight - 16 + offsets[i];
        const aBottom = a.worldY - 16 + offsets[i];
        const bTop = b.worldY - b.bubbleHeight - 16 + offsets[j];
        const bBottom = b.worldY - 16 + offsets[j];

        // Overlap exists if one range intersects the other
        if (aBottom > bTop && bBottom > aTop) {
          // Push the upper bubble (i, which has smaller worldY) further up
          const overlap = aBottom - bTop;
          offsets[i] -= overlap + 8;
        }
      }
    }

    // Apply offsets
    for (let i = 0; i < activeBubbles.length; i++) {
      activeBubbles[i].display.getSpeechBubble().applyStackOffset(offsets[i]);
    }
  }

  private createAgent(state: AgentVisualState): AgentEntry {
    const display = new AgentSpriteDisplay(
      state.agentId,
      state.name,
      state.color,
      this.spritesheet ?? undefined,
    );

    display.setPosition(state.currentX, state.currentY);

    if (this.onAgentClick) {
      const handler = this.onAgentClick;
      display.onClick(() => handler(state.agentId));
    }

    return { display, agentId: state.agentId };
  }

  private updateAgent(entry: AgentEntry, state: AgentVisualState, delta: number): void {
    const { display } = entry;

    if (state.moving) {
      // Store direction once at movement start to prevent jitter during lerp
      if (!this.lerpProgress.has(state.agentId)) {
        this.movementDirections.set(state.agentId, {
          dx: state.targetX - state.currentX,
          dy: state.targetY - state.currentY,
        });
      }

      const progress = this.lerpProgress.get(state.agentId) ?? 0;
      const speedMul = state.speedMultiplier ?? 1;
      const newProgress = Math.min(progress + delta * 0.02 * speedMul, 1);
      this.lerpProgress.set(state.agentId, newProgress);

      const t = easeInOutQuad(newProgress);
      const x = state.currentX + (state.targetX - state.currentX) * t;
      const y = state.currentY + (state.targetY - state.currentY) * t;

      display.setPosition(x, y);
      const dir = this.movementDirections.get(state.agentId)!;
      display.setMoving(dir.dx, dir.dy);

      if (newProgress >= 1) {
        this.lerpProgress.delete(state.agentId);
        this.movementDirections.delete(state.agentId);
        display.setMoving(0, 0);
      }
    } else {
      display.setPosition(state.targetX, state.targetY);
      display.setMoving(0, 0);
      this.lerpProgress.delete(state.agentId);
      this.movementDirections.delete(state.agentId);
    }

    display.updateName(state.name);
    display.update(delta);
  }

  destroy(): void {
    for (const entry of this.agents.values()) {
      entry.display.destroy();
    }
    this.agents.clear();
    this.lerpProgress.clear();
    this.movementDirections.clear();
    this.container.destroy({ children: true });
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
