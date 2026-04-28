// TODO(tranche-6C): wire to a future global session-search backend.
//
// AgenC currently has no cross-session message-search index. Upstream's
// dialog drives ripgrep across the workspace; AgenC will eventually
// drive it across persisted session transcripts. Until that backend
// lands this file ships as a visual stub so the keybinding/launcher
// surface can be wired up without a runtime gap.
//
// When the backend arrives, replace the stub body with a port of
// upstream's debounced search loop and remove this notice.

import * as React from 'react'
import { Box, Text } from '../ink-public.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  readonly onDone: () => void
  /**
   * Kept in the signature so the eventual wired implementation can
   * insert a path/line reference into the composer. Today we ignore it.
   */
  readonly onInsert?: (text: string) => void
}

export function GlobalSearchDialog({ onDone }: Props): React.ReactElement {
  void (undefined as unknown as Props['onInsert']) // silence unused-warning when consumers omit the field.
  return (
    <Dialog title="Global Search" onCancel={onDone}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>Indexing not yet available.</Text>
        <Box marginTop={1}>
          <Text dimColor>
            Try Quick Open (Ctrl+O) or History Search (Ctrl+R) instead.
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
