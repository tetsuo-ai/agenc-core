/**
 * A provider's announced retirement date on a catalog row (`retiresOn`), and
 * what it means once the date has arrived.
 *
 * The bundled catalog is a snapshot, so it keeps a model after its provider
 * has retired it. Where the bundled catalog is what a list or a selection is
 * read from, a row past its date is left out of the list and refused at
 * selection (model-catalog-selection.ts). The provider's own list wins: a
 * model its live or cached live list has in this process is never hidden or
 * refused over a date, provided the provider gave that list on or after the
 * date. A list it gave before the date says only that the model was there
 * until then; a cache file can be days old, and a daemon keeps the list it
 * downloaded. Before a selection is refused, the list cached in the session's
 * home is read as well, since another process may have read the provider's
 * list there (session/cached-live-model-list.ts).
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
import {
  publishedModelCatalogEntry,
  publishedModelCatalogReadAt,
} from "./published-model-catalog.js";

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

/** A model whose provider has retired it, as far as this process can tell. */
export interface RetiredBundledModel {
  /** The id the catalog registers the model under. */
  readonly model: string;
  /** The date the provider announced, YYYY-MM-DD. */
  readonly retiredOn: string;
}

/**
 * `model` and its retirement date, when the date has arrived and nothing
 * newer says the provider still has the model.
 *
 * - The provider's list in this process does not have the model: the
 *   bundled row registered under exactly this id speaks, and the model is
 *   retired once that row's date has arrived.
 * - The list has the model and the provider gave the list on or after the
 *   date (or nobody recorded when): the list wins and the model is not
 *   retired, whatever the date.
 * - The list has the model but the provider gave it before the date: the
 *   list does not reach that far. The date decides, the list's own row's
 *   when it carries one, the bundled row's otherwise.
 *
 * Undefined in every other case: no row under this id, a row with no date,
 * a date still ahead.
 */
export function retiredBundledModel(
  provider: string,
  model: string,
  now: Date = new Date(),
): RetiredBundledModel | undefined {
  const providerId = provider.trim().toLowerCase();
  const bundled = findBundledModelCatalogEntry({ provider: providerId, model });
  const listed = publishedModelCatalogEntry(providerId, model);
  if (listed === undefined) {
    return bundled?.retiresOn !== undefined && isModelRetired(bundled, now)
      ? { model: bundled.model, retiredOn: bundled.retiresOn }
      : undefined;
  }
  const listReadAt = publishedModelCatalogReadAt(providerId);
  const dated = listed.retiresOn !== undefined ? listed : bundled;
  const start = retirementStart(dated?.retiresOn);
  if (
    dated?.retiresOn === undefined ||
    start === undefined ||
    listReadAt === undefined ||
    listReadAt >= start ||
    start > now.getTime()
  ) {
    return undefined;
  }
  return { model: dated.model, retiredOn: dated.retiresOn };
}
