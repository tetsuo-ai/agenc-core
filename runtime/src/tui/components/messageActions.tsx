// Cherry-picked from openclaude src/components/messageActions.tsx.
//
// The full openclaude messageActions.tsx (~449 LOC) implements
// virtual-list message navigation tied to openclaude's RenderableMessage
// types + analytics event logging. AgenC's wholesale-ported transcript
// layer has its own message-cursor system and AgenC has no analytics
// shim, so only the InVirtualListContext export is reproduced here —
// the single piece consumed by the wholesale-ported CtrlOToExpand.

import React from "react";

/**
 * True when rendered inside a virtualized message list. Suppresses
 * inline expand-hints (e.g. CtrlOToExpand) that would render redundantly
 * across many list rows.
 */
export const InVirtualListContext = React.createContext<boolean>(false);
