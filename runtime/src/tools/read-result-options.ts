import { getSelectedProviderEnvironment } from "../utils/model/providers.js";

function booleanOption(value: string | undefined, fallback: boolean): boolean {
  switch (value?.trim().toLowerCase()) {
    case "1": case "true": case "yes": case "on": return true;
    case "0": case "false": case "no": case "off": return false;
    default: return fallback;
  }
}

export function readRangeNoteEnabled(): boolean {
  return booleanOption(getSelectedProviderEnvironment().AGENC_READ_RANGE_NOTE, true);
}

export function readDedupEnabled(): boolean {
  return booleanOption(getSelectedProviderEnvironment().AGENC_READ_DEDUP, false);
}
