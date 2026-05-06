import axios from 'axios'
import { readFile, stat } from 'fs/promises'
import type { Message } from '../../../types/message'
import { checkAndRefreshOAuthTokenIfNeeded } from '../../../agenc/upstream/utils/auth' // upstream-import: keep target is owned by another Z-PURGE item
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../../../agenc/upstream/utils/errors' // upstream-import: keep target is owned by another Z-PURGE item
import { getAuthHeaders, getUserAgent } from '../../../agenc/upstream/utils/http' // upstream-import: keep target is owned by another Z-PURGE item
import { normalizeMessagesForAPI } from '../../../agenc/upstream/utils/messages' // upstream-import: keep target is owned by another Z-PURGE item
import {
  extractAgentIdsFromMessages,
  getTranscriptPath,
  loadSubagentTranscripts,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../../agenc/upstream/utils/sessionStorage' // upstream-import: keep target is owned by another Z-PURGE item
import { jsonStringify } from '../../../agenc/upstream/utils/slowOperations' // upstream-import: keep target is owned by another Z-PURGE item
import { redactSensitiveInfo } from '../Feedback'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

export async function submitTranscriptShare(
  messages: Message[],
  trigger: TranscriptShareTrigger,
  appearanceId: string,
): Promise<TranscriptShareResult> {
  try {
    logForDebugging('Collecting transcript for sharing', { level: 'info' })

    const transcript = normalizeMessagesForAPI(messages)

    // Collect subagent transcripts
    const agentIds = extractAgentIdsFromMessages(messages)
    const subagentTranscripts = await loadSubagentTranscripts(agentIds)

    // Read raw JSONL transcript (with size guard to prevent OOM)
    let rawTranscriptJsonl: string | undefined
    try {
      const transcriptPath = getTranscriptPath()
      const { size } = await stat(transcriptPath)
      if (size <= MAX_TRANSCRIPT_READ_BYTES) {
        rawTranscriptJsonl = await readFile(transcriptPath, 'utf-8')
      } else {
        logForDebugging(
          `Skipping raw transcript read: file too large (${size} bytes)`,
          { level: 'warn' },
        )
      }
    } catch {
      // File may not exist
    }

    const data = {
      trigger,
      version: MACRO.VERSION,
      platform: process.platform,
      transcript,
      subagentTranscripts:
        Object.keys(subagentTranscripts).length > 0
          ? subagentTranscripts
          : undefined,
      rawTranscriptJsonl,
    }

    const content = redactSensitiveInfo(jsonStringify(data))

    await checkAndRefreshOAuthTokenIfNeeded()

    const authResult = getAuthHeaders()
    if (authResult.error) {
      return { success: false }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers,
    }

    const response = await axios.post(
      'https://agenc.tech/api/agenc_shared_session_transcripts',
      { content, appearance_id: appearanceId },
      {
        headers,
        timeout: 30000,
      },
    )

    if (response.status === 200 || response.status === 201) {
      const result = response.data
      logForDebugging('Transcript shared successfully', { level: 'info' })
      return {
        success: true,
        transcriptId: result?.transcript_id,
      }
    }

    return { success: false }
  } catch (err) {
    logForDebugging(errorMessage(err), {
      level: 'error',
    })
    return { success: false }
  }
}
