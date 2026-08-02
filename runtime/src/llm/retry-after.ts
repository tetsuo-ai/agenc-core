/** RFC 9110 Retry-After parsing at the provider HTTP adapter boundary. */

import {
  classifyRetryAfterMilliseconds,
  type RetryAfterDirective,
} from "../recovery/reconnect-policy.js";

const IMF_FIXDATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u;
const RFC850_DATE_PATTERN =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u;
const ASCTIME_DATE_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( {2}[1-9]| [0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/u;
const NONFINITE_RETRY_AFTER_PATTERN = /^(?:NaN|[+-]?Infinity)$/iu;
const NEGATIVE_DELAY_SECONDS_PATTERN = /^-[0-9]+$/u;
const DELAY_SECONDS_PATTERN = /^[0-9]+$/u;
const HTTP_OPTIONAL_WHITESPACE_PATTERN = /^[\t ]+|[\t ]+$/gu;
const MILLISECONDS_PER_SECOND = 1_000;
const LAST_HOUR_OF_DAY = 23;
const LAST_MINUTE_OF_HOUR = 59;
const LAST_REGULAR_SECOND_OF_MINUTE = 59;
const LEAP_SECOND = 60;
const YEARS_PER_CENTURY = 100;
const OBSOLETE_DATE_FUTURE_YEARS = 50;
const MAX_SAFE_DELAY_SECONDS = Math.floor(
  Number.MAX_SAFE_INTEGER / MILLISECONDS_PER_SECOND,
);
const SHORT_WEEKDAY_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
} as const);
const LONG_WEEKDAY_INDEX = Object.freeze({
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
} as const);
const MONTH_INDEX = Object.freeze({
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
} as const);

interface HttpDateParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly weekday: number;
  readonly year: number;
}

export function parseProviderRetryAfterDirective(
  headers: Headers,
  nowMs = Date.now(),
): RetryAfterDirective {
  const rawRetryAfter = headers.get("retry-after");
  if (rawRetryAfter === null) {
    return Object.freeze({ classification: "absent" });
  }
  const retryAfter = rawRetryAfter.replace(
    HTTP_OPTIONAL_WHITESPACE_PATTERN,
    "",
  );
  if (retryAfter.length === 0) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "syntax",
    });
  }

  if (NEGATIVE_DELAY_SECONDS_PATTERN.test(retryAfter)) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "negative",
    });
  }
  if (NONFINITE_RETRY_AFTER_PATTERN.test(retryAfter)) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "non_finite",
    });
  }
  if (DELAY_SECONDS_PATTERN.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (!Number.isSafeInteger(seconds) || seconds > MAX_SAFE_DELAY_SECONDS) {
      return Object.freeze({
        classification: "invalid",
        invalidReason: "overflow",
      });
    }
    return classifyRetryAfterMilliseconds(seconds * MILLISECONDS_PER_SECOND);
  }

  if (!Number.isFinite(nowMs)) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "non_finite",
    });
  }
  const absoluteMs = parseHttpDateMilliseconds(retryAfter, nowMs);
  if (absoluteMs === undefined) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "syntax",
    });
  }
  const floorMs = Math.max(0, Math.ceil(absoluteMs - nowMs));
  if (!Number.isSafeInteger(floorMs)) {
    return Object.freeze({
      classification: "invalid",
      invalidReason: "overflow",
    });
  }
  return classifyRetryAfterMilliseconds(floorMs);
}

function parseHttpDateMilliseconds(
  value: string,
  nowMs: number,
): number | undefined {
  const imf = IMF_FIXDATE_PATTERN.exec(value);
  if (imf !== null) {
    return validatedHttpDateMilliseconds({
      weekday: SHORT_WEEKDAY_INDEX[
        imf[1] as keyof typeof SHORT_WEEKDAY_INDEX
      ],
      day: Number(imf[2]),
      month: MONTH_INDEX[imf[3] as keyof typeof MONTH_INDEX],
      year: Number(imf[4]),
      hour: Number(imf[5]),
      minute: Number(imf[6]),
      second: Number(imf[7]),
    });
  }

  const rfc850 = RFC850_DATE_PATTERN.exec(value);
  if (rfc850 !== null) {
    const dateWithoutYear = {
      weekday: LONG_WEEKDAY_INDEX[
        rfc850[1] as keyof typeof LONG_WEEKDAY_INDEX
      ],
      day: Number(rfc850[2]),
      month: MONTH_INDEX[rfc850[3] as keyof typeof MONTH_INDEX],
      hour: Number(rfc850[5]),
      minute: Number(rfc850[6]),
      second: Number(rfc850[7]),
    } as const;
    return validatedHttpDateMilliseconds({
      ...dateWithoutYear,
      year: resolveObsoleteHttpYear(
        Number(rfc850[4]),
        dateWithoutYear,
        nowMs,
      ),
    });
  }

  const asctime = ASCTIME_DATE_PATTERN.exec(value);
  if (asctime === null) return undefined;
  return validatedHttpDateMilliseconds({
    weekday: SHORT_WEEKDAY_INDEX[
      asctime[1] as keyof typeof SHORT_WEEKDAY_INDEX
    ],
    day: Number(asctime[3]?.replace(/^ +/u, "")),
    month: MONTH_INDEX[asctime[2] as keyof typeof MONTH_INDEX],
    year: Number(asctime[7]),
    hour: Number(asctime[4]),
    minute: Number(asctime[5]),
    second: Number(asctime[6]),
  });
}

function resolveObsoleteHttpYear(
  twoDigitYear: number,
  parts: Omit<HttpDateParts, "year">,
  nowMs: number,
): number {
  const currentYear = new Date(nowMs).getUTCFullYear();
  const currentCentury =
    Math.floor(currentYear / YEARS_PER_CENTURY) * YEARS_PER_CENTURY;
  const candidate = currentCentury + twoDigitYear;
  const candidateMs = unvalidatedHttpDateMilliseconds({
    ...parts,
    year: candidate,
  });
  const futureThreshold = new Date(nowMs);
  futureThreshold.setUTCFullYear(currentYear + OBSOLETE_DATE_FUTURE_YEARS);
  return candidateMs > futureThreshold.getTime()
    ? candidate - YEARS_PER_CENTURY
    : candidate;
}

function validatedHttpDateMilliseconds(
  parts: HttpDateParts,
): number | undefined {
  const isLeapSecond = parts.second === LEAP_SECOND;
  if (
    isLeapSecond &&
    (parts.hour !== LAST_HOUR_OF_DAY ||
      parts.minute !== LAST_MINUTE_OF_HOUR)
  ) {
    return undefined;
  }
  const normalizedParts = isLeapSecond
    ? { ...parts, second: LAST_REGULAR_SECOND_OF_MINUTE }
    : parts;
  const milliseconds = unvalidatedHttpDateMilliseconds(normalizedParts);
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== normalizedParts.year ||
    date.getUTCMonth() !== normalizedParts.month ||
    date.getUTCDate() !== normalizedParts.day ||
    date.getUTCHours() !== normalizedParts.hour ||
    date.getUTCMinutes() !== normalizedParts.minute ||
    date.getUTCSeconds() !== normalizedParts.second ||
    date.getUTCDay() !== normalizedParts.weekday ||
    !Number.isFinite(milliseconds)
  ) {
    return undefined;
  }
  if (!isLeapSecond) return milliseconds;
  const leapSecondMilliseconds = milliseconds + MILLISECONDS_PER_SECOND;
  return Number.isSafeInteger(leapSecondMilliseconds)
    ? leapSecondMilliseconds
    : undefined;
}

function unvalidatedHttpDateMilliseconds(parts: HttpDateParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}
