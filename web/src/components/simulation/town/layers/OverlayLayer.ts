/**
 * Overlay layer for relationship lines between agents.
 */

import { Container } from 'pixi.js';
import { RelationshipLine } from '../sprites/RelationshipLine';
import type { AgentVisualState } from '../hooks/useTownState';

interface RelationshipData {
  fromId: string;
  toId: string;
  sentiment: number;
}

export class OverlayLayerManager {
  readonly container: Container;
  private lines = new Map<string, RelationshipLine>();
  private visible = true;

  constructor() {
    this.container = new Container();
    this.container.label = 'overlay';
  }

  updateRelationships(
    relationships: RelationshipData[],
    agentPositions: Map<string, { x: number; y: number }>,
  ): void {
    const activeKeys = new Set<string>();

    for (const rel of relationships) {
      const key = `${rel.fromId}:${rel.toId}`;
      activeKeys.add(key);

      const fromPos = agentPositions.get(rel.fromId);
      const toPos = agentPositions.get(rel.toId);
      if (!fromPos || !toPos) continue;

      let line = this.lines.get(key);
      if (!line) {
        line = new RelationshipLine(rel.fromId, rel.toId);
        this.lines.set(key, line);
        this.container.addChild(line.graphics);
      }

      line.update(fromPos.x, fromPos.y, toPos.x, toPos.y, rel.sentiment);
    }

    // Remove stale lines
    for (const [key, line] of this.lines) {
      if (!activeKeys.has(key)) {
        this.container.removeChild(line.graphics);
        line.destroy();
        this.lines.delete(key);
      }
    }
  }

  extractRelationships(agents: AgentVisualState[], agentStates: Record<string, { relationships: Array<{ otherAgentId: string; sentiment: number }> }>): RelationshipData[] {
    const rels: RelationshipData[] = [];
    const seen = new Set<string>();

    for (const agent of agents) {
      const state = agentStates[agent.agentId];
      if (!state?.relationships) continue;

      for (const rel of state.relationships) {
        const pairKey = [agent.agentId, rel.otherAgentId].sort().join(':');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        rels.push({
          fromId: agent.agentId,
          toId: rel.otherAgentId,
          sentiment: rel.sentiment,
        });
      }
    }

    return rels;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.container.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    for (const line of this.lines.values()) {
      line.destroy();
    }
    this.lines.clear();
    this.container.destroy({ children: true });
  }
}
