/**
 * AgenC TUI root React component.
 *
 * Wave 2 scope: layer the AgenC-side providers on top of the Ink
 * contexts that ship with the reconciler. The Ink class component in
 * `ink/components/App.tsx` is what gets mounted by `render()` at the
 * top of the tree; it already provides `TerminalSizeContext`,
 * `AppContext`, `StdinContext`, `TerminalFocusContext`, `ClockContext`,
 * and `CursorDeclarationContext` to all descendants. This component
 * therefore lives inside those six contexts — we do NOT wrap them
 * again here (wrapping them a second time would pin stale values).
 *
 * The provider stack this module owns, outer to inner:
 *
 *     <AgenCAppStateProvider>
 *       <KeybindingProvider>
 *         <OverlayProvider>
 *           <TUIRoot />
 *         </OverlayProvider>
 *       </KeybindingProvider>
 *     </AgenCAppStateProvider>
 *
 * `KeybindingProvider` comes from Wave 2-B's
 * `runtime/src/tui/keybindings/KeybindingContext.tsx` once that lands.
 * Until then we import the placeholder stub exported by
 * `./state/AppState.tsx`.
 */

import React, { type ReactNode } from "react";

import Box from "./ink/components/Box.js";
import Text from "./ink/components/Text.js";

import {
  AgenCAppStateProvider,
  KeybindingProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike,
} from "./state/AppState.js";
import { OverlayProvider, useOverlayStack } from "./overlay/OverlayProvider.js";
import { Banner } from "./cockpit/Banner.js";

export interface AppProps {
  readonly session: SessionLike;
  readonly configStore: ConfigStoreLike;
  /**
   * Optional override for the keybinding map. Wave 2-B owns the real
   * resolver; App.tsx just forwards whatever it receives through the
   * placeholder provider.
   */
  readonly bindings?: unknown;
  /**
   * Model label shown in the cockpit banner. Wave 4-B will derive this
   * from config/session state; Wave 2 accepts it as a prop so tests can
   * drive the value directly.
   */
  readonly model?: string;
}

/**
 * Thin placeholder for the three cockpit regions. Wave 3 (transcript)
 * and Waves 4-5 (cockpit + composer) fill these in; for now we render
 * empty slots with AgenC palette tags so later waves can slot cleanly.
 */
function TUIRoot({
  model,
}: {
  readonly model?: string;
}): React.ReactElement {
  const { mode } = useAgenCAppState();
  const { overlays } = useOverlayStack();
  return (
    <Box flexDirection="column">
      {/* cockpit region (top) */}
      <Box flexDirection="column">
        <Banner mode={mode} model={model} />
      </Box>
      {/* transcript region (middle, flex:1) — filled by Wave 3 */}
      <Box flexDirection="column" flexGrow={1}>
        <Text dim>[transcript]</Text>
      </Box>
      {/* composer region (bottom) — filled by Wave 4-A */}
      <Box flexDirection="column">
        <Text dim>[composer]</Text>
      </Box>
      {/* overlay stack — rendered above everything else */}
      {overlays.map((entry) => (
        <OverlayFrame key={entry.id}>{entry.node}</OverlayFrame>
      ))}
    </Box>
  );
}

function OverlayFrame({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

export const App: React.FC<AppProps> = ({
  session,
  configStore,
  bindings,
  model,
}) => {
  return (
    <AgenCAppStateProvider session={session} configStore={configStore}>
      <KeybindingProvider bindings={bindings}>
        <OverlayProvider>
          <TUIRoot model={model} />
        </OverlayProvider>
      </KeybindingProvider>
    </AgenCAppStateProvider>
  );
};

export default App;
