import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { parseCsv } from "../../../src/agents/jobs/csv-reader.js";
import { openFndFixtureCatalog } from "../../helpers/fnd-fixtures.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "b1-csv-prototype-header-roundtrip",
    task: "B1",
    fingerprint: "B1:CSV:PROTOTYPE-HEADER-INERT-ROUNDTRIP",
  });
  const catalog = await openFndFixtureCatalog();
  const document = parseCsv(await catalog.text("csv.prototype-headers.v1"));
  const row = document.rows[0];
  if (row === undefined) throw new Error("CSV fixture did not produce a row");
  const hasOwnPrototypeHeader = Object.hasOwn(row, "__proto__");
  const observed = Object.freeze({
    hasOwnPrototypeHeader,
    prototypeHeaderValue: hasOwnPrototypeHeader ? row["__proto__"] : null,
  });

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    observed,
    Object.freeze({
      hasOwnPrototypeHeader: true,
      prototypeHeaderValue: "synthetic-proto",
    }),
  );
}
