/**
 * Agent layer: colored circles with name labels.
 * Phase 1 MVP — replaced by AgentSprite in Phase 2.
 * Uses imperative PixiJS API.
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { AgentVisualState } from '../hooks/useTownState';

const AGENT_RADIUS = 10;
const LABEL_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 10,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: 'center',
});

interface AgentDisplay {
  container: Container;
  circle: Graphics;
  label: Text;
  agentId: string;
}

export class AgentLayerManager {
  readonly container: Container;
  private agents = new Map<string, AgentDisplay>();
  private lerpProgress = new Map<string, number>();

  constructor() {
    this.container = new Container();
    this.container.label = 'agents';
  }

  update(agentStates: AgentVisualState[], delta: number): void {
    const activeIds = new Set<string>();

    for (const state of agentStates) {
      activeIds.add(state.agentId);

      let display = this.agents.get(state.agentId);
      if (!display) {
        display = this.createAgentDisplay(state);
        this.agents.set(state.agentId, display);
        this.container.addChild(display.container);
      }

      this.updateAgentDisplay(display, state, delta);
    }

    // Remove agents that are no longer present
    for (const [id, display] of this.agents) {
      if (!activeIds.has(id)) {
        this.container.removeChild(display.container);
        display.container.destroy({ children: true });
        this.agents.delete(id);
        this.lerpProgress.delete(id);
      }
    }
  }

  private createAgentDisplay(state: AgentVisualState): AgentDisplay {
    const container = new Container();
    container.label = `agent-${state.agentId}`;

    const circle = new Graphics();
    circle.circle(0, 0, AGENT_RADIUS);
    circle.fill(state.color);
    circle.stroke({ width: 2, color: 0xffffff, alpha: 0.8 });
    container.addChild(circle);

    const label = new Text({
      text: state.name,
      style: LABEL_STYLE,
    });
    label.anchor.set(0.5, 0);
    label.y = AGENT_RADIUS + 4;
    container.addChild(label);

    container.x = state.currentX;
    container.y = state.currentY;

    return { container, circle, label, agentId: state.agentId };
  }

  private updateAgentDisplay(
    display: AgentDisplay,
    state: AgentVisualState,
    delta: number,
  ): void {
    if (state.moving) {
      const progress = this.lerpProgress.get(state.agentId) ?? 0;
      const newProgress = Math.min(progress + delta * 0.02, 1); // ~1 second lerp at 60fps
      this.lerpProgress.set(state.agentId, newProgress);

      const t = easeInOutQuad(newProgress);
      display.container.x = state.currentX + (state.targetX - state.currentX) * t;
      display.container.y = state.currentY + (state.targetY - state.currentY) * t;

      if (newProgress >= 1) {
        this.lerpProgress.delete(state.agentId);
      }
    } else {
      display.container.x = state.targetX;
      display.container.y = state.targetY;
      this.lerpProgress.delete(state.agentId);
    }

    // Update label text if changed
    if (display.label.text !== state.name) {
      display.label.text = state.name;
    }
  }

  getPositions(): Map<string, { x: number; y: number; locationId: string | null }> {
    const positions = new Map<string, { x: number; y: number; locationId: string | null }>();
    // Positions are tracked externally via useTownState
    return positions;
  }

  destroy(): void {
    for (const display of this.agents.values()) {
      display.container.destroy({ children: true });
    }
    this.agents.clear();
    this.lerpProgress.clear();
    this.container.destroy({ children: true });
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
