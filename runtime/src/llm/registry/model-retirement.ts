/**
 * A provider's announced retirement date on a catalog row (`retiresOn`), and
 * what it means once the date has arrived.
 *
 * The bundled catalog is a snapshot, so it keeps a model after its provider
 * has retired it. Where the bundled catalog is what a list or a selection is
 * read from, a row past its date is left out of the list and refused at
 * selection (model-catalog-selection.ts). The provider's own list wins: a
 * model its live or cached live list has in this process is never hidden or
 * refused over a bundled date. Before a selection is refused, the list cached
 * in the session's home is read as well, since another process may have read
 * the provider's list there (session/cached-live-model-list.ts).
 *
 * The rule is the same for every provider that fills in `retiresOn`
 * (OpenRouter's `expiration_date`, Venice's `model_spec.deprecation`).
 *
 * @module
 */

import {
  findBundledModelCatalogEntry,
  type RegisteredModelCatalogEntry,
} from "./model-catalog.js";
import { publishedModelCatalogEntry } from "./published-model-catalog.js";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** The first instant (UTC) of a real YYYY-MM-DD date; undefined for any other text. */
function retirementStart(retiresOn: string | undefined): number | undefined {
  if (retiresOn === undefined || !CALENDAR_DATE.test(retiresOn)) return undefined;
  const start = Date.parse(`${retiresOn}T00:00:00.000Z`);
  // The engine reads 2026-02-31 as March 3. Only a date that prints back
  // unchanged is a real one.
  return !Number.isNaN(start) && new Date(start).toISOString().slice(0, 10) === retiresOn
    ? start
    : undefined;
}

/**
 * Whether the entry's retirement date has arrived: `retiresOn` is a real
 * YYYY-MM-DD date on or before today's UTC date. An entry with no date, or
 * with text that is not a real date, is not retired. `now` is the clock;
 * tests pass their own.
 */
export function isModelRetired(
  entry: Pick<RegisteredModelCatalogEntry, "retiresOn">,
  now: Date = new Date(),
): boolean {
  const start = retirementStart(entry.retiresOn);
  return start !== undefined && start <= now.getTime();
}

/** A model the bundled catalog says its provider has retired. */
export interface RetiredBundledModel {
  /** The id the bundled catalog registers the model under. */
  readonly model: string;
  /** The date the provider announced, YYYY-MM-DD. */
  readonly retiredOn: string;
}

/**
 * The bundled row of `model`, when the bundled catalog is what speaks for the
 * model and the row's retirement date has arrived. Undefined when the
 * provider's live list in this process has the model (its list wins), when
 * no bundled row is registered under exactly this id, and when the row is
 * not retired.
 */
export function retiredBundledModel(
  provider: string,
  model: string,
  now: Date = new Date(),
): RetiredBundledModel | undefined {
  const providerId = provider.trim().toLowerCase();
  if (publishedModelCatalogEntry(providerId, model) !== undefined) return undefined;
  const entry = findBundledModelCatalogEntry({ provider: providerId, model });
  if (entry?.retiresOn === undefined || !isModelRetired(entry, now)) return undefined;
  return { model: entry.model, retiredOn: entry.retiresOn };
}
