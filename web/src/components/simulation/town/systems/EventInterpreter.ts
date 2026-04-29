/**
 * Translates SSE simulation events into visual commands for the town view.
 */

import type { SimulationEvent } from '../../useSimulation';

export type VisualCommandType = 'move' | 'speech' | 'action' | 'idle';

export interface VisualCommand {
  type: VisualCommandType;
  agentName: string;
  text?: string;
  destination?: string;
  duration?: number;
}

const SPEECH_DURATION_MS = 4000;
const ACTION_DURATION_MS = 3000;

export function interpretEvent(event: SimulationEvent): VisualCommand | null {
  if (!event.agent_name) return null;

  switch (event.type) {
    case 'action': {
      const destination = extractDestination(event);
      if (destination) {
        return {
          type: 'move',
          agentName: event.agent_name,
          destination,
          text: event.content ?? undefined,
          duration: ACTION_DURATION_MS,
        };
      }
      return {
        type: 'action',
        agentName: event.agent_name,
        text: event.content ?? event.resolved_event ?? undefined,
        duration: ACTION_DURATION_MS,
      };
    }

    case 'observation':
      return {
        type: 'speech',
        agentName: event.agent_name,
        text: truncateText(event.content ?? '', 60),
        duration: SPEECH_DURATION_MS,
      };

    case 'resolution':
      return {
        type: 'speech',
        agentName: event.agent_name,
        text: truncateText(event.resolved_event ?? event.content ?? '', 60),
        duration: SPEECH_DURATION_MS,
      };

    case 'reflection':
      return {
        type: 'speech',
        agentName: event.agent_name,
        text: truncateText(event.content ?? '', 50),
        duration: SPEECH_DURATION_MS,
      };

    case 'scene_change':
      return {
        type: 'move',
        agentName: event.agent_name,
        destination: event.scene ?? undefined,
        duration: ACTION_DURATION_MS,
      };

    default:
      return null;
  }
}

export function interpretEvents(events: SimulationEvent[]): VisualCommand[] {
  const commands: VisualCommand[] = [];
  for (const event of events) {
    const cmd = interpretEvent(event);
    if (cmd) commands.push(cmd);
  }
  return commands;
}

function extractDestination(event: SimulationEvent): string | null {
  if (event.intent && typeof event.intent === 'object') {
    const dest = (event.intent as Record<string, unknown>).destination;
    if (typeof dest === 'string') return dest;
  }
  if (event.action_spec && typeof event.action_spec === 'object') {
    const dest = event.action_spec.destination;
    if (typeof dest === 'string') return dest;
  }
  return null;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
