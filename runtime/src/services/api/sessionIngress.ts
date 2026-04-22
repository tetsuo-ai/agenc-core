// @ts-nocheck
import axios, { type AxiosError } from "axios";
import type { UUID } from "crypto";
import { getOauthConfig } from "../../constants/oauth.js";
import type { Entry, TranscriptMessage } from "../../types/logs.js";
import { logForDebugging } from "../../utils/debug.js";
import { logForDiagnosticsNoPII } from "../../utils/diagLogs.js";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { logError } from "../../utils/log.js";
import { sequential } from "../../utils/sequential.js";
import { getSessionIngressAuthHeaders } from "../../utils/sessionIngressAuth.js";
import { sleep } from "../../utils/sleep.js";
import { jsonStringify } from "../../utils/slowOperations.js";

interface SessionIngressError {
  error?: {
    message?: string;
    type?: string;
  };
}

type SessionAppendHeaders = Record<string, string>;

type TeleportEventsResponse = {
  data: Array<{
    event_id: string;
    event_type: string;
    is_compaction: boolean;
    payload: Entry | null;
    created_at: string;
  }>;
  next_cursor?: string;
};

const lastUuidMap = new Map<string, UUID>();

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

const sequentialAppendBySession = new Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: SessionAppendHeaders,
  ) => Promise<boolean>
>();

function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId);
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: SessionAppendHeaders,
      ) => appendSessionLogImpl(sessionId, entry, url, headers),
    );
    sequentialAppendBySession.set(sessionId, sequentialAppend);
  }
  return sequentialAppend;
}

function buildOAuthHeaders(
  accessToken: string,
  orgUUID?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (orgUUID) {
    headers["x-organization-uuid"] = orgUUID;
  }
  return headers;
}

function getSessionHeaders(): Record<string, string> | null {
  const headers = getSessionIngressAuthHeaders();
  return Object.keys(headers).length > 0 ? headers : null;
}

async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: SessionAppendHeaders,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const lastUuid = lastUuidMap.get(sessionId);
      const requestHeaders = { ...headers };
      if (lastUuid) {
        requestHeaders["Last-Uuid"] = lastUuid;
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200 || response.status === 201) {
        lastUuidMap.set(sessionId, entry.uuid);
        logForDebugging(
          `Successfully persisted session log entry for session ${sessionId}`,
        );
        return true;
      }

      if (response.status === 409) {
        const serverLastUuid = response.headers["x-last-uuid"];
        if (serverLastUuid === entry.uuid) {
          lastUuidMap.set(sessionId, entry.uuid);
          logForDebugging(
            `Session entry ${entry.uuid} already present on server, recovering from stale state`,
          );
          logForDiagnosticsNoPII("info", "session_persist_recovered_from_409");
          return true;
        }

        if (serverLastUuid) {
          lastUuidMap.set(sessionId, serverLastUuid as UUID);
          logForDebugging(
            `Session 409: adopting server lastUuid=${serverLastUuid} from header, retrying entry ${entry.uuid}`,
          );
        } else {
          const logs = await fetchSessionLogsFromUrl(sessionId, url, headers);
          const adoptedUuid = findLastUuid(logs);
          if (adoptedUuid) {
            lastUuidMap.set(sessionId, adoptedUuid);
            logForDebugging(
              `Session 409: re-fetched ${logs.length} entries, adopting lastUuid=${adoptedUuid}, retrying entry ${entry.uuid}`,
            );
          } else {
            const errorData = response.data as SessionIngressError;
            const errorMessage =
              errorData.error?.message ?? "Concurrent modification detected";
            logError(
              new Error(
                `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
              ),
            );
            logForDiagnosticsNoPII(
              "error",
              "session_persist_fail_concurrent_modification",
            );
            return false;
          }
        }
        logForDiagnosticsNoPII("info", "session_persist_409_adopt_server_uuid");
        continue;
      }

      if (response.status === 401) {
        logForDebugging("Session token expired or invalid");
        logForDiagnosticsNoPII("error", "session_persist_fail_bad_token");
        return false;
      }

      logForDebugging(
        `Failed to persist session log: ${response.status} ${response.statusText}`,
      );
      logForDiagnosticsNoPII("error", "session_persist_fail_status", {
        status: response.status,
        attempt,
      });
    } catch (error) {
      const axiosError = error as AxiosError<SessionIngressError>;
      logError(new Error(`Error persisting session log: ${axiosError.message}`));
      logForDiagnosticsNoPII("error", "session_persist_fail_status", {
        status: axiosError.status,
        attempt,
      });
    }

    if (attempt === MAX_RETRIES) {
      logForDebugging(`Remote persistence failed after ${MAX_RETRIES} attempts`);
      logForDiagnosticsNoPII(
        "error",
        "session_persist_error_retries_exhausted",
        { attempt },
      );
      return false;
    }

    const delayMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 8_000);
    logForDebugging(
      `Remote persistence attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms…`,
    );
    await sleep(delayMs);
  }

  return false;
}

export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  const headers = getSessionHeaders();
  if (!headers) {
    logForDebugging("No session token available for session persistence");
    logForDiagnosticsNoPII("error", "session_persist_fail_jwt_no_token");
    return false;
  }

  const sequentialAppend = getOrCreateSequentialAppend(sessionId);
  return sequentialAppend(entry, url, {
    ...headers,
    "Content-Type": "application/json",
  });
}

export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const headers = getSessionHeaders();
  if (!headers) {
    logForDebugging("No session token available for fetching session logs");
    logForDiagnosticsNoPII("error", "session_get_fail_no_token");
    return null;
  }

  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers);
  if (logs && logs.length > 0) {
    const lastEntry = logs.at(-1);
    if (lastEntry && "uuid" in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid);
    }
  }

  return logs;
}

export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const url = `${getOauthConfig().BASE_API_URL}/v1/session_ingress/session/${sessionId}`;
  logForDebugging(`[session-ingress] Fetching session logs from: ${url}`);
  return fetchSessionLogsFromUrl(
    sessionId,
    url,
    buildOAuthHeaders(accessToken, orgUUID),
  );
}

export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`;
  const headers = buildOAuthHeaders(accessToken, orgUUID);

  logForDebugging(`[teleport] Fetching events from: ${baseUrl}`);

  const all: Entry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 100;

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1_000 };
    if (cursor !== undefined) {
      params.cursor = cursor;
    }

    let response;
    try {
      response = await axios.get<TeleportEventsResponse>(baseUrl, {
        headers,
        params,
        timeout: 20_000,
        validateStatus: (status) => status < 500,
      });
    } catch (error) {
      const axiosError = error as AxiosError;
      logError(new Error(`Teleport events fetch failed: ${axiosError.message}`));
      logForDiagnosticsNoPII("error", "teleport_events_fetch_fail");
      return null;
    }

    if (response.status === 404) {
      logForDebugging(`[teleport] Session ${sessionId} not found (page ${pages})`);
      logForDiagnosticsNoPII("warn", "teleport_events_not_found");
      return pages === 0 ? null : all;
    }

    if (response.status === 401) {
      logForDiagnosticsNoPII("error", "teleport_events_bad_token");
      throw new Error(
        "Your session has expired. Please run /login to sign in again.",
      );
    }

    if (response.status !== 200) {
      logError(
        new Error(
          `Teleport events returned ${response.status}: ${jsonStringify(response.data)}`,
        ),
      );
      logForDiagnosticsNoPII("error", "teleport_events_bad_status");
      return null;
    }

    const { data, next_cursor } = response.data;
    if (!Array.isArray(data)) {
      logError(
        new Error(
          `Teleport events invalid response shape: ${jsonStringify(response.data)}`,
        ),
      );
      logForDiagnosticsNoPII("error", "teleport_events_invalid_shape");
      return null;
    }

    for (const event of data) {
      if (event.payload !== null) {
        all.push(event.payload);
      }
    }

    pages += 1;
    if (next_cursor == null) {
      break;
    }
    cursor = next_cursor;
  }

  if (pages >= maxPages) {
    logError(
      new Error(`Teleport events hit page cap (${maxPages}) for ${sessionId}`),
    );
    logForDiagnosticsNoPII("warn", "teleport_events_page_cap");
  }

  logForDebugging(
    `[teleport] Fetched ${all.length} events over ${pages} page(s) for ${sessionId}`,
  );
  return all;
}

async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20_000,
      validateStatus: (status) => status < 500,
      params: isEnvTruthy(process.env.CLAUDE_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    });

    if (response.status === 200) {
      const data = response.data;
      if (!data || typeof data !== "object" || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        );
        logForDiagnosticsNoPII("error", "session_get_fail_invalid_response");
        return null;
      }

      const logs = data.loglines as Entry[];
      logForDebugging(
        `Fetched ${logs.length} session logs for session ${sessionId}`,
      );
      return logs;
    }

    if (response.status === 404) {
      logForDebugging(`No existing logs for session ${sessionId}`);
      logForDiagnosticsNoPII("warn", "session_get_no_logs_for_session");
      return [];
    }

    if (response.status === 401) {
      logForDebugging("Auth token expired or invalid");
      logForDiagnosticsNoPII("error", "session_get_fail_bad_token");
      throw new Error(
        "Your session has expired. Please run /login to sign in again.",
      );
    }

    logForDebugging(
      `Failed to fetch session logs: ${response.status} ${response.statusText}`,
    );
    logForDiagnosticsNoPII("error", "session_get_fail_status", {
      status: response.status,
    });
    return null;
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>;
    logError(new Error(`Error fetching session logs: ${axiosError.message}`));
    logForDiagnosticsNoPII("error", "session_get_fail_status", {
      status: axiosError.status,
    });
    return null;
  }
}

function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) {
    return undefined;
  }
  const entry = logs.findLast((item) => "uuid" in item && item.uuid);
  return entry && "uuid" in entry ? (entry.uuid as UUID) : undefined;
}

export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId);
  sequentialAppendBySession.delete(sessionId);
}

export function clearAllSessions(): void {
  lastUuidMap.clear();
  sequentialAppendBySession.clear();
}
