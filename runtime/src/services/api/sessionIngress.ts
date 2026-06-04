import axios, { type AxiosError } from 'axios'
import type { UUID } from 'crypto'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { sequential } from '../../utils/sequential.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'

interface SessionIngressError {
  error?: {
    message?: string
    type?: string
  }
}

const lastUuidMap = new Map<string, UUID>()
const sequentialAppendBySession = new Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: Record<string, string>,
  ) => Promise<boolean>
>()

const MAX_RETRIES = 10
const BASE_DELAY_MS = 500

function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}

async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const lastUuid = lastUuidMap.get(sessionId)
      const requestHeaders = { ...headers }
      if (lastUuid) {
        requestHeaders['Last-Uuid'] = lastUuid
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
        validateStatus: status => status < 500,
      })

      if (response.status === 200 || response.status === 201) {
        lastUuidMap.set(sessionId, entry.uuid)
        return true
      }

      if (response.status === 409) {
        const serverLastUuid = response.headers['x-last-uuid']
        if (serverLastUuid === entry.uuid) {
          lastUuidMap.set(sessionId, entry.uuid)
          logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
          return true
        }

        if (serverLastUuid) {
          lastUuidMap.set(sessionId, serverLastUuid as UUID)
          logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
          continue
        }

        const logs = await fetchSessionLogsFromUrl(url, headers)
        const adoptedUuid = findLastUuid(logs)
        if (adoptedUuid) {
          lastUuidMap.set(sessionId, adoptedUuid)
          logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
          continue
        }

        const errorData = response.data as SessionIngressError
        const errorMessage =
          errorData.error?.message || 'Concurrent modification detected'
        logError(
          new Error(
            `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
          ),
        )
        logForDiagnosticsNoPII(
          'error',
          'session_persist_fail_concurrent_modification',
        )
        return false
      }

      if (response.status === 401) {
        logForDebugging('Session token expired or invalid')
        logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
        return false
      }

      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: response.status,
        attempt,
      })
    } catch (error) {
      const axiosError = error as AxiosError<SessionIngressError>
      logError(new Error(`Error persisting session log: ${axiosError.message}`))
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: axiosError.status,
        attempt,
      })
    }

    if (attempt === MAX_RETRIES) {
      logForDebugging(`Remote persistence failed after ${MAX_RETRIES} attempts`)
      logForDiagnosticsNoPII(
        'error',
        'session_persist_error_retries_exhausted',
        { attempt },
      )
      return false
    }

    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 8000)
    await sleep(delayMs)
  }

  return false
}

export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for session persistence')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  }

  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  return sequentialAppend(entry, url, headers)
}

export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for fetching session logs')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }

  const logs = await fetchSessionLogsFromUrl(url, {
    Authorization: `Bearer ${sessionToken}`,
  })

  const lastUuid = findLastUuid(logs)
  if (lastUuid) {
    lastUuidMap.set(sessionId, lastUuid)
  }

  return logs
}

async function fetchSessionLogsFromUrl(
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: status => status < 500,
      params: isEnvTruthy(process.env.AGENC_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })

    if (response.status === 200) {
      const data = response.data
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        )
        logForDiagnosticsNoPII('error', 'session_get_fail_invalid_response')
        return null
      }
      return data.loglines as Entry[]
    }

    if (response.status === 404) {
      return []
    }

    if (response.status === 401) {
      logForDebugging('Auth token expired or invalid')
      logForDiagnosticsNoPII('error', 'session_get_fail_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: response.status,
    })
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`Error fetching session logs: ${axiosError.message}`))
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: axiosError.status,
    })
    return null
  }
}

function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) return undefined
  const entry = logs.findLast(e => 'uuid' in e && e.uuid)
  return entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined
}

export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
