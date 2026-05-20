import React from "react";
import { describe, expect, test } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { Box } from "../ink.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { parseBindings } from "../keybindings/parser.js";
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from "../keybindings/types.js";
import { ConfigurableShortcutHint } from "./ConfigurableShortcutHint.js";

const bindings = parseBindings([
  {
    context: "Global",
    bindings: {
      "ctrl+shift+o": "app:toggleTranscript",
    },
  },
]);

function ConfiguredKeybindings({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const activeContexts = React.useMemo(() => new Set<KeybindingContextName>(), []);
  const handlerRegistryRef = React.useRef(new Map());
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null);

  return (
    <KeybindingProvider
      activeContexts={activeContexts}
      bindings={bindings}
      handlerRegistryRef={handlerRegistryRef}
      pendingChord={pendingChordRef.current}
      pendingChordRef={pendingChordRef}
      registerActiveContext={context => activeContexts.add(context)}
      setPendingChord={pending => {
        pendingChordRef.current = pending;
      }}
      unregisterActiveContext={context => activeContexts.delete(context)}
    >
      {children}
    </KeybindingProvider>
  );
}

describe("ConfigurableShortcutHint coverage", () => {
  test("renders fallback text without a provider and configured text with one", async () => {
    const output = await renderToString(
      <Box flexDirection="column">
        <ConfigurableShortcutHint
          action="app:toggleTranscript"
          context="Global"
          fallback="ctrl+o"
          description="expand"
          parens
          bold
        />
        <ConfiguredKeybindings>
          <ConfigurableShortcutHint
            action="app:toggleTranscript"
            context="Global"
            fallback="ctrl+o"
            description="expand"
          />
        </ConfiguredKeybindings>
      </Box>,
      100,
    );

    expect(output).toContain("(ctrl+o to expand)");
    expect(output).toContain("ctrl+shift+o to expand");
  });
});
