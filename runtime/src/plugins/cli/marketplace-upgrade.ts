import {
  addMarketplaceOp,
  findMarketplaceName,
  readMarketplaceIndex,
  type MarketplaceOperationOptions,
  type MarketplaceRecord,
} from "./marketplace-add.js";

export interface UpgradeMarketplaceInput extends MarketplaceOperationOptions {
  readonly name?: string;
}

export interface UpgradeMarketplaceEntryResult {
  readonly marketplace: MarketplaceRecord;
  readonly previousRevision?: string;
  readonly changed: boolean;
}

export interface UpgradeMarketplaceResult {
  readonly upgraded: readonly UpgradeMarketplaceEntryResult[];
}

export async function upgradeMarketplaceOp(
  input: UpgradeMarketplaceInput,
): Promise<UpgradeMarketplaceResult> {
  const index = await readMarketplaceIndex(input);
  const names = input.name !== undefined
    ? [findRequiredMarketplaceName(index, input.name)]
    : Object.keys(index.marketplaces).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    return { upgraded: [] };
  }
  const upgraded: UpgradeMarketplaceEntryResult[] = [];
  for (const name of names) {
    const existing = index.marketplaces[name]!;
    const result = await addMarketplaceOp({
      ...input,
      source: existing.source,
      name: existing.name,
      ...(existing.ref !== undefined ? { ref: existing.ref } : {}),
      ...(existing.sparse !== undefined ? { sparse: existing.sparse } : {}),
      force: true,
    });
    upgraded.push({
      marketplace: result.marketplace,
      ...(existing.revision !== undefined ? { previousRevision: existing.revision } : {}),
      changed: existing.revision === undefined ||
        result.marketplace.revision === undefined ||
        existing.revision !== result.marketplace.revision ||
        result.marketplace.sourceType === "local",
    });
  }
  return { upgraded };
}

function findRequiredMarketplaceName(
  index: Awaited<ReturnType<typeof readMarketplaceIndex>>,
  name: string,
): string {
  const matched = findMarketplaceName(index, name);
  if (matched === undefined) {
    throw new Error(`marketplace is not configured: ${name}`);
  }
  return matched;
}
