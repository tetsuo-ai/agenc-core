// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { feature } from 'bun:bundle'
import { useMemo } from 'react'
import { useCommandQueue } from '../../hooks/useCommandQueue.js'
import { useAppState } from '../../state/AppState.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getExampleCommandFromCache } from '../../../utils/exampleCommands.js'
import { isQueuedCommandEditable } from '../../../utils/messageQueueManager.js'
import { isPromptInputProactiveActive } from './proactiveAdapter.js'

type Props = {
  input: string
  submitCount: number
  viewingAgentName?: string
}

const NUM_TIMES_QUEUE_HINT_SHOWN = 3
const MAX_TEAMMATE_NAME_LENGTH = 20

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
}: Props): string | undefined {
  const queuedCommands = useCommandQueue()
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled)
  const placeholder = useMemo(() => {
    if (input !== '') {
      return
    }

    // Show teammate hint when viewing teammate
    if (viewingAgentName) {
      const displayName =
        viewingAgentName.length > MAX_TEAMMATE_NAME_LENGTH
          ? viewingAgentName.slice(0, MAX_TEAMMATE_NAME_LENGTH - 3) + '...'
          : viewingAgentName
      return `Message @${displayName}…`
    }

    // Show queue hint if user has not seen it yet.
    // Only count user-editable commands — task-notification and isMeta
    // are hidden from the prompt area (see PromptInputQueuedCommands).
    if (
      queuedCommands.some(isQueuedCommandEditable) &&
      (getGlobalConfig().queuedCommandUpHintCount || 0) <
        NUM_TIMES_QUEUE_HINT_SHOWN
    ) {
      return 'Press up to edit queued messages'
    }

    // Proactive mode: the model drives the conversation, so onboarding hints
    // (the example command AND the cold-start fallback below) are irrelevant
    // and would block prompt suggestions from showing.
    const proactiveActive =
      (feature('PROACTIVE') || feature('KAIROS')) &&
      isPromptInputProactiveActive()

    // Show an example command if the user has not submitted yet and suggestions
    // are enabled.
    if (submitCount < 1 && promptSuggestionEnabled && !proactiveActive) {
      return getExampleCommandFromCache()
    }

    // Cold start fallback: when no example command, teammate, or queue hint
    // applies (e.g. prompt suggestions disabled), the composer would otherwise
    // sit blank at rest. Surface a stable, on-brand hint so a new user always
    // knows what to type. It disappears as soon as input is non-empty (guarded
    // above) and renders dim like every other placeholder.
    if (submitCount < 1 && !proactiveActive) {
      return 'Describe a task, or / for commands'
    }
  }, [
    input,
    queuedCommands,
    submitCount,
    promptSuggestionEnabled,
    viewingAgentName,
  ])

  return placeholder
}
