import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToString } from '../utils/staticRender.js'
import { PlanApprovalOverlay } from './components/PlanApprovalOverlay.js'
import { AppStateProvider, getDefaultAppState } from '../../src/tui/state/AppState.js'

// useInput needs a raw-mode stdin; static render has none.
vi.mock('../../src/tui/ink.js', async () => {
  const actual = await vi.importActual('../../src/tui/ink.js')
  return { ...actual, useInput: () => {} }
})

const PLAN = `# Plan: Local file load for HTML video player

## Context
The repo already has a polished HTML5 player in video/ (index.html + styles + script, expects media/demo.mp4). The player currently fails because the demo asset is missing.

## Approach

| File | Change |
|---|---|
| video/index.html | File input, Open button, optional drop hint; update header copy |
| video/script.js | Load/revoke object URLs; wire picker + DnD; clear error overlay on success |
| video/styles.css | Light styles for open button + drag-over state on stage |
| video/media/.gitkeep | Unchanged (still useful if someone prefers a fixed path) |

## Steps
1. Add an "Open file" control wired to a hidden input[type=file].
2. Drag-and-drop onto the player stage with revoke on replace/unload.
3. Clear the error overlay when a file loads successfully.
4. Update the header copy to explain local-file playback.

## Verification
- Open video/index.html directly in the browser (no server needed).
- Pick an MP4: playback starts, controls work.
- Drop a second file: replaces the first without leaks (old object URL revoked).
- No new dependencies. No backend.
`

async function renderOverlay(): Promise<string> {
  return renderToString(
    <AppStateProvider initialState={getDefaultAppState()}>
      <PlanApprovalOverlay
        planContent={PLAN}
        planFilePath="/home/paul/.agenc/plans/probe.md"
        onApprove={() => {}}
        onKeepPlanning={() => {}}
      />
    </AppStateProvider>,
    { columns: 110, rows: 50 },
  )
}

describe('PlanApprovalOverlay clamp', () => {
  it('keeps the approval options visible by clamping long plans', async () => {
    const out = await renderOverlay()
    // The clamp hint reports the real line counts.
    expect(out).toContain('first 14 of 26 lines · ctrl+o to expand')
    // The options block is always visible (never pushed off by the plan).
    expect(out).toContain('would you like to proceed?')
    expect(out).toContain('yes, and auto-accept edits')
    expect(out).toContain('no, keep planning')
    // The plan tail is clipped out of the preview.
    expect(out).not.toContain('No new dependencies. No backend.')
    // The head of the plan still renders.
    expect(out).toContain('Plan: Local file load for HTML video player')
  })
})
