import {
  disableAllPluginsOp,
  installPluginOp,
  listInstalledPlugins,
  setPluginEnabledOp,
  uninstallPluginOp,
  updatePluginOp,
  validatePluginPath,
  type DisableAllPluginsResult,
  type InstallPluginInput,
  type InstallPluginResult,
  type PluginListResult,
  type PluginOperationOptions,
  type SetPluginEnabledInput,
  type SetPluginEnabledResult,
  type UninstallPluginInput,
  type UninstallPluginResult,
  type UpdatePluginInput,
  type UpdatePluginResult,
} from "./pluginOperations.js";
import {
  addMarketplaceOp,
  type AddMarketplaceInput,
  type AddMarketplaceResult,
} from "./marketplace-add.js";
import {
  removeMarketplaceOp,
  type RemoveMarketplaceInput,
  type RemoveMarketplaceResult,
} from "./marketplace-remove.js";
import {
  upgradeMarketplaceOp,
  type UpgradeMarketplaceInput,
  type UpgradeMarketplaceResult,
} from "./marketplace-upgrade.js";

export class AgenCPluginInstallationManager {
  private readonly options: PluginOperationOptions;

  constructor(options: PluginOperationOptions = {}) {
    this.options = options;
  }

  list(): Promise<PluginListResult> {
    return listInstalledPlugins(this.options);
  }

  validate(path: string, options: { readonly marketplace?: boolean } = {}) {
    return validatePluginPath(path, options);
  }

  install(input: Omit<InstallPluginInput, keyof PluginOperationOptions>): Promise<InstallPluginResult> {
    return installPluginOp({ ...this.options, ...input });
  }

  uninstall(input: Omit<UninstallPluginInput, keyof PluginOperationOptions>): Promise<UninstallPluginResult> {
    return uninstallPluginOp({ ...this.options, ...input });
  }

  update(input: Omit<UpdatePluginInput, keyof PluginOperationOptions>): Promise<UpdatePluginResult> {
    return updatePluginOp({ ...this.options, ...input });
  }

  setEnabled(input: Omit<SetPluginEnabledInput, keyof PluginOperationOptions>): Promise<SetPluginEnabledResult> {
    return setPluginEnabledOp({ ...this.options, ...input });
  }

  disableAll(): Promise<DisableAllPluginsResult> {
    return disableAllPluginsOp(this.options);
  }

  addMarketplace(input: Omit<AddMarketplaceInput, keyof PluginOperationOptions>): Promise<AddMarketplaceResult> {
    return addMarketplaceOp({ ...this.options, ...input });
  }

  removeMarketplace(input: Omit<RemoveMarketplaceInput, keyof PluginOperationOptions>): Promise<RemoveMarketplaceResult> {
    return removeMarketplaceOp({ ...this.options, ...input });
  }

  upgradeMarketplace(input: Omit<UpgradeMarketplaceInput, keyof PluginOperationOptions> = {}): Promise<UpgradeMarketplaceResult> {
    return upgradeMarketplaceOp({ ...this.options, ...input });
  }
}
