import { rm, stat } from "node:fs/promises";
import {
  findMarketplaceName,
  readMarketplaceIndex,
  writeMarketplaceIndex,
  type MarketplaceRecord,
  type MarketplaceOperationOptions,
} from "./marketplace-add.js";

export interface RemoveMarketplaceInput extends MarketplaceOperationOptions {
  readonly name: string;
}

export interface RemoveMarketplaceResult {
  readonly marketplace: MarketplaceRecord;
  readonly removedInstall: boolean;
}

export async function removeMarketplaceOp(
  input: RemoveMarketplaceInput,
): Promise<RemoveMarketplaceResult> {
  const index = await readMarketplaceIndex(input);
  const matchedName = findMarketplaceName(index, input.name);
  if (matchedName === undefined) {
    throw new Error(`marketplace is not configured: ${input.name}`);
  }
  const marketplace = index.marketplaces[matchedName]!;
  const nextMarketplaces = { ...index.marketplaces };
  delete nextMarketplaces[matchedName];
  let removedInstall = false;
  try {
    await stat(marketplace.installedPath);
    await rm(marketplace.installedPath, { recursive: true, force: true });
    removedInstall = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeMarketplaceIndex({
    version: 1,
    marketplaces: nextMarketplaces,
  }, input);
  return { marketplace, removedInstall };
}
