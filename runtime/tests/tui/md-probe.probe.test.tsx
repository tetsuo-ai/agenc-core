import { describe, it } from 'vitest'
import React from 'react'
import { renderToString } from '../utils/staticRender.js'
import { Markdown } from './components/markdown/Markdown.js'
import { AppStateProvider, getDefaultAppState } from '../../src/tui/state/AppState.js'

const CONTENT = "## Three runtime control points\n\n### What each owns\nSlash commands route user `/` input; the sandbox broker is the final host-exec gate; spinner token-rate is a TUI liveness metric during streaming.\n\n### How decisions are made\nLookup, isolation mode, and display thresholds stay local to each subsystem\u2014no shared policy engine.\n\n| area | core file | decision logic |\n|---|---|---|\n| slash command registry | `src/commands/dispatcher.ts` | Parse first line only; `registry.find`; skip mistyped paths; block `userInvocable: false` / disabled; catch `execute` errors; mask sensitive args |\n| sandbox broker | `src/sandbox/execution-broker.ts` | Restricted modes must sandbox or throw; only `danger_full_access` / `external_sandbox` pass host cmd; `prepareSpawn` / `assertReady` by surface |\n| spinner token-rate | `src/tui/components/spinner/SpinnerAnimationRow.tsx` | Rate = tokens/elapsed after \u226520 tokens and \u22655s; else 0; stall note after 8s silence; show counts after 3s |"

describe('md probe exact 2', () => {
  it('renders the last message', async () => {
    const out = await renderToString(<AppStateProvider initialState={getDefaultAppState()}><Markdown>{CONTENT}</Markdown></AppStateProvider>, { columns: 110, rows: 50 })
    console.log('---RENDER---')
    console.log(out)
    console.log('---END---')
  })
})
