import { isRecord } from "../utils/record.js";

type StartupInternalEvent = {
  readonly payload: Record<string, unknown>;
  readonly agent_id?: string;
};

const MAX_STARTUP_INTERNAL_EVENT_PAGES = 1000;

function normalizeStartupInternalEventPage(
  value: unknown,
):
  | { readonly events: StartupInternalEvent[]; readonly nextCursor?: string }
  | null {
  if (!isRecord(value)) return null;

  const rawData = value.data;
  const events: StartupInternalEvent[] = [];
  if (rawData !== undefined) {
    if (!Array.isArray(rawData)) return null;
    for (const rawEvent of rawData) {
      if (!isRecord(rawEvent) || !isRecord(rawEvent.payload)) continue;
      events.push({
        payload: rawEvent.payload,
        ...(typeof rawEvent.agent_id === "string"
          ? { agent_id: rawEvent.agent_id }
          : {}),
      });
    }
  }

  const rawCursor = value.next_cursor;
  if (rawCursor === undefined || rawCursor === null || rawCursor === "") {
    return { events };
  }
  if (typeof rawCursor !== "string") return null;
  return { events, nextCursor: rawCursor };
}

export async function fetchStartupInternalEvents(params: {
  readonly sessionBaseUrl: string;
  readonly headers: Record<string, string>;
  readonly subagents?: boolean;
}): Promise<StartupInternalEvent[] | null> {
  const allEvents: StartupInternalEvent[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (
    let pageCount = 0;
    pageCount < MAX_STARTUP_INTERNAL_EVENT_PAGES;
    pageCount++
  ) {
    const url = new URL(`${params.sessionBaseUrl}/worker/internal-events`);
    if (params.subagents) {
      url.searchParams.set("subagents", "true");
    }
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, {
      headers: params.headers,
    });
    if (!response.ok) {
      return null;
    }

    let rawPage: unknown;
    try {
      rawPage = await response.json();
    } catch {
      return null;
    }

    const page = normalizeStartupInternalEventPage(rawPage);
    if (page === null) {
      return null;
    }

    allEvents.push(...page.events);

    if (!page.nextCursor) {
      return allEvents;
    }
    if (seenCursors.has(page.nextCursor)) {
      return null;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return null;
}
