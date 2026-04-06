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
      }
    }
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
      const progress = this.lerpProgress.get(state.agentId) ?? 0;
      const newProgress = Math.min(progress + delta * 0.02, 1);
      this.lerpProgress.set(state.agentId, newProgress);

      const t = easeInOutQuad(newProgress);
      const x = state.currentX + (state.targetX - state.currentX) * t;
      const y = state.currentY + (state.targetY - state.currentY) * t;

      display.setPosition(x, y);
      display.setMoving(state.targetX - state.currentX, state.targetY - state.currentY);

      if (newProgress >= 1) {
        this.lerpProgress.delete(state.agentId);
        display.setMoving(0, 0);
      }
    } else {
      display.setPosition(state.targetX, state.targetY);
      display.setMoving(0, 0);
      this.lerpProgress.delete(state.agentId);
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
    this.container.destroy({ children: true });
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
