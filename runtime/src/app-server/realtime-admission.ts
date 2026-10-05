export const TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START = Symbol(
  "test-only-allow-unadmitted-realtime-start",
);

export const REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC =
  "thread/realtime/start is disabled: realtime provider traffic has no durable run/step admission, bounded budget reservation, or authoritative usage reconciliation; use ordinary daemon session turns until realtime admission is implemented";
