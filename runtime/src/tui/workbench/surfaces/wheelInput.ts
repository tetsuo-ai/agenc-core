import type { DOMElement } from "../../ink/dom.js";
import type { InputEvent } from "../../ink/events/input-event.js";
import { nodeCache } from "../../ink/node-cache.js";

/**
 * True when a wheel event targets the given node's rect. Kept in its own
 * module (not in BufferSurface) so lightweight surfaces (PreviewSurface, the
 * review rail) can handle wheel input without importing the whole buffer
 * editor stack (providers, neovim discovery) into their module graph.
 */
export function wheelInputIsInsideNode(event: InputEvent, node: DOMElement | null): boolean {
  if (!event.key.wheelUp && !event.key.wheelDown) return true;
  const point = wheelPointFromInputEvent(event);
  if (!point) return false;
  if (!node) return false;
  const rect = nodeCache.get(node);
  if (!rect) return false;
  return point.column >= rect.x &&
    point.column < rect.x + rect.width &&
    point.row >= rect.y &&
    point.row < rect.y + rect.height;
}

function wheelPointFromInputEvent(event: InputEvent): { readonly column: number; readonly row: number } | null {
  const raw = event.keypress.raw ?? event.keypress.sequence ?? "";
  const sgr = /\x1B\[<\d+;(\d+);(\d+)[Mm]/.exec(raw);
  if (sgr) {
    return { column: Number(sgr[1]) - 1, row: Number(sgr[2]) - 1 };
  }
  if (raw.length === 6 && raw.startsWith("\x1B[M")) {
    return {
      column: raw.charCodeAt(4) - 33,
      row: raw.charCodeAt(5) - 33,
    };
  }
  return null;
}
