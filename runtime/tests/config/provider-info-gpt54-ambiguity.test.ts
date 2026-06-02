/**
 * Regression test for catalog-drift collision on the bare slug "gpt-5.4".
 *
 * `gpt-5.4` is a registered OpenAI catalog model (model-catalog.ts) with
 * `visibility: "list"`, so deriveFlatCatalog surfaces it into
 * BUILT_IN_PROVIDER_MODEL_CATALOG.openai. It was ALSO hand-listed in the github
 * provider catalog literal (provider-info.ts), so the same bare slug appeared
 * under two providers. resolveModelDisambiguated inverts the catalog by model
 * slug; a bare-slug selection (no `provider:` prefix, no `--provider`, no
 * `model_provider`) of "gpt-5.4" therefore matched BOTH openai and github and
 * threw AmbiguousModelError. At startup that aborts the daemon (process.exit(1));
 * in the /model command the throw is swallowed and the provider is silently
 * dropped.
 *
 * Fix: drop the bare "gpt-5.4" alias from the github catalog literal so the slug
 * resolves unambiguously to its registry-owned openai entry.
 *
 * This test fails if the fix is reverted (i.e. if github re-lists bare "gpt-5.4").
 */

import { describe, expect, it } from "vitest";

import {
  AmbiguousModelError,
  resolveModelDisambiguated,
} from "../../src/config/schema.js";
import { buildProviderModelCatalog } from "../../src/config/resolve-provider.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../src/llm/registry/provider-info.js";
import { deriveFlatCatalog } from "../../src/llm/registry/model-catalog.js";

const AMBIGUOUS_SLUG = "gpt-5.4";

describe("catalog drift: bare slug 'gpt-5.4' must not collide across providers", () => {
  it("fixture sanity: gpt-5.4 is registry-owned by openai (visibility: list)", () => {
    // The model still surfaces under openai via the single-source registry.
    expect(deriveFlatCatalog().openai).toContain(AMBIGUOUS_SLUG);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toContain(AMBIGUOUS_SLUG);
  });

  it("does not list the bare 'gpt-5.4' alias under the github provider", () => {
    // The bare alias under github is what created the cross-provider collision.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).not.toContain(AMBIGUOUS_SLUG);
  });

  it("appears under exactly one provider in the built provider catalog", () => {
    const catalog = buildProviderModelCatalog(undefined);
    const owners = Object.entries(catalog)
      .filter(([, models]) => models.includes(AMBIGUOUS_SLUG))
      .map(([provider]) => provider);
    expect(owners).toEqual(["openai"]);
  });

  it("resolves a bare 'gpt-5.4' selection to openai without throwing", () => {
    const catalog = buildProviderModelCatalog(undefined);
    const resolved = resolveModelDisambiguated(AMBIGUOUS_SLUG, catalog);
    expect(resolved).toEqual({ provider: "openai", model: AMBIGUOUS_SLUG });
  });

  it("does not throw AmbiguousModelError for the bare 'gpt-5.4' slug", () => {
    const catalog = buildProviderModelCatalog(undefined);
    expect(() => resolveModelDisambiguated(AMBIGUOUS_SLUG, catalog)).not.toThrow(
      AmbiguousModelError,
    );
  });
});
