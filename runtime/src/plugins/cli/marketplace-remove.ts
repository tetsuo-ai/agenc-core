import { realpath, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findMarketplaceName,
  marketplaceInstalledPath,
  marketplaceStoreRoot,
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
  const installedPath = marketplaceInstalledPath(marketplace.name, input);
  await assertMarketplaceInstallPath(installedPath, input);
  try {
    await stat(installedPath);
    await rm(installedPath, { recursive: true, force: true });
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

async function assertMarketplaceInstallPath(
  installedPath: string,
  options: MarketplaceOperationOptions,
): Promise<void> {
  const storeReal = await realpath(marketplaceStoreRoot(options));
  const normalized = resolve(installedPath);
  if (normalized === storeReal || !normalized.startsWith(`${storeReal}/`)) {
    throw new Error("marketplace install path must stay inside the marketplace store");
  }
}
