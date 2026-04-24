import React, {
  useCallback,
  useMemo,
  useState,
} from "react";

import {
  getConfigActionPaletteItems,
  getConfigProfilePaletteItems,
  getExitWorktreePaletteItems,
  getModelPaletteItems,
  getPermissionModePaletteItems,
  getPermissionsActionPaletteItems,
  getProviderPaletteItems,
} from "./composer/palette-sources.js";
import {
  ModelSelectionOverlay,
  type ModelSelectionItem,
} from "./overlay/ModelSelectionOverlay.js";
import type { OverlayContextValue } from "./overlay/OverlayProvider.js";
import type { PickerCommandIntent } from "./picker-intents.js";
import {
  formatPickerProviderLabel,
  normalizePickerProvider,
} from "./picker-format.js";
import type { ConfigStoreLike } from "./state/AppState.js";

interface PickerControllerOptions {
  readonly configStore: ConfigStoreLike;
  readonly overlay: Pick<OverlayContextValue, "pushOverlay" | "popOverlay">;
  readonly providerSlug?: string;
  readonly submit: (message: string) => Promise<unknown>;
}

interface PickerPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value?: string;
}

function toModelSelectionItem(item: PickerPaletteItem): ModelSelectionItem {
  return {
    id: item.id,
    label: item.label,
    description: item.description,
    value: item.value,
  };
}

export function usePickerController({
  configStore,
  overlay,
  providerSlug,
  submit,
}: PickerControllerOptions): (intent: PickerCommandIntent) => void {
  return useCallback((intent: PickerCommandIntent): void => {
    const config = configStore.current?.();
    const currentProvider = normalizePickerProvider(providerSlug);

    let overlayId = "";
    const closeOverlay = (): void => {
      if (overlayId.length > 0) {
        overlay.popOverlay(overlayId);
      }
    };

    const submitSlashSelection = (command: string): void => {
      closeOverlay();
      void submit(command).catch(() => {
        // Slash-command failures surface through the normal session event path.
      });
    };

    if (intent.kind === "model") {
      const items = getModelPaletteItems({
        provider: currentProvider,
        config,
      }).map(toModelSelectionItem);

      overlayId = overlay.pushOverlay(
        <ModelSelectionOverlay
          title="Select Model"
          subtitle={`Choose a model for ${formatPickerProviderLabel(currentProvider)}.`}
          items={items}
          onSelect={(item) => submitSlashSelection(`/model ${item.label}`)}
          onClose={closeOverlay}
        />,
      );
      return;
    }

    if (intent.kind === "model-provider") {
      const providerItems = getProviderPaletteItems().map(toModelSelectionItem);

      const ProviderStepper = (): React.ReactElement => {
        const [selectedProvider, setSelectedProvider] = useState(currentProvider);
        const [tab, setTab] = useState<"Provider" | "Model">("Provider");

        const providerModels = useMemo(() => {
          const defaults: ModelSelectionItem[] = [
            {
              id: `${selectedProvider}:default`,
              label: "Default recommended",
              description: `Use ${formatPickerProviderLabel(selectedProvider)} default model`,
            },
          ];
          return defaults.concat(
            getModelPaletteItems({
              provider: selectedProvider,
              config,
            }).map(toModelSelectionItem),
          );
        }, [config, selectedProvider]);

        if (tab === "Provider") {
          return (
            <ModelSelectionOverlay
              title="Select Model Provider"
              subtitle="Choose a provider, then pick a model for it."
              tabs={["Provider", "Model"]}
              activeTab="Provider"
              onTabChange={(nextTab) => {
                if (nextTab === "Model") {
                  setTab("Model");
                }
              }}
              items={providerItems}
              onSelect={(item) => {
                setSelectedProvider(item.id);
                setTab("Model");
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Select Model Provider"
            subtitle={`Choose a model for ${formatPickerProviderLabel(selectedProvider)}.`}
            tabs={["Provider", "Model"]}
            activeTab="Model"
            onTabChange={(nextTab) => {
              if (nextTab === "Provider") {
                setTab("Provider");
              }
            }}
            items={providerModels}
            onSelect={(item) => {
              const command =
                item.id === `${selectedProvider}:default`
                  ? `/model-provider ${selectedProvider}`
                  : `/model-provider ${selectedProvider} ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
            onBack={() => setTab("Provider")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<ProviderStepper />);
      return;
    }

    if (intent.kind === "permissions") {
      const modeItems = getPermissionModePaletteItems().map(toModelSelectionItem);

      if (intent.stage === "mode") {
        overlayId = overlay.pushOverlay(
          <ModelSelectionOverlay
            title="Permission Mode"
            subtitle="Choose the approval mode for this session."
            items={modeItems}
            onSelect={(item) =>
              submitSlashSelection(`/permissions mode ${item.label}`)}
            onClose={closeOverlay}
          />,
        );
        return;
      }

      const actionItems = getPermissionsActionPaletteItems().map(
        toModelSelectionItem,
      );

      const PermissionsStepper = (): React.ReactElement => {
        const [tab, setTab] = useState<"Action" | "Mode">("Action");

        if (tab === "Action") {
          return (
            <ModelSelectionOverlay
              title="Permissions"
              subtitle="Inspect permissions, export rules, or change the approval mode."
              tabs={["Action", "Mode"]}
              activeTab="Action"
              onTabChange={(nextTab) => {
                if (nextTab === "Mode") {
                  setTab("Mode");
                }
              }}
              items={actionItems}
              onSelect={(item) => {
                if (item.id === "permissions:mode") {
                  setTab("Mode");
                  return;
                }
                submitSlashSelection(`/permissions ${item.value ?? item.label}`);
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Permissions"
            subtitle="Choose the approval mode for this session."
            tabs={["Action", "Mode"]}
            activeTab="Mode"
            onTabChange={(nextTab) => {
              if (nextTab === "Action") {
                setTab("Action");
              }
            }}
            items={modeItems}
            onSelect={(item) =>
              submitSlashSelection(`/permissions mode ${item.label}`)}
            onClose={closeOverlay}
            onBack={() => setTab("Action")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<PermissionsStepper />);
      return;
    }

    if (intent.kind === "config") {
      const rootItems = getConfigActionPaletteItems().map(toModelSelectionItem);
      const profileItems = [
        {
          id: "config:profile:show",
          label: "Show active profile",
          description: "Display the current active profile and available profiles",
          value: "profile",
        },
        ...getConfigProfilePaletteItems(config).map(toModelSelectionItem),
      ];

      if (intent.stage === "profile") {
        overlayId = overlay.pushOverlay(
          <ModelSelectionOverlay
            title="Config Profile"
            subtitle="Choose a declared config profile for the next turn."
            items={profileItems}
            onSelect={(item) => {
              const command =
                item.id === "config:profile:show"
                  ? "/config profile"
                  : `/config profile ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
          />,
        );
        return;
      }

      const ConfigStepper = (): React.ReactElement => {
        const [tab, setTab] = useState<"Action" | "Profile">("Action");

        if (tab === "Action") {
          return (
            <ModelSelectionOverlay
              title="Config"
              subtitle="Inspect runtime config, reload it, or switch profiles."
              tabs={["Action", "Profile"]}
              activeTab="Action"
              onTabChange={(nextTab) => {
                if (nextTab === "Profile") {
                  setTab("Profile");
                }
              }}
              items={rootItems}
              onSelect={(item) => {
                if (item.id === "config:profile") {
                  setTab("Profile");
                  return;
                }
                submitSlashSelection(`/config ${item.value ?? item.label}`);
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Config"
            subtitle="Choose a declared config profile for the next turn."
            tabs={["Action", "Profile"]}
            activeTab="Profile"
            onTabChange={(nextTab) => {
              if (nextTab === "Action") {
                setTab("Action");
              }
            }}
            items={profileItems}
            onSelect={(item) => {
              const command =
                item.id === "config:profile:show"
                  ? "/config profile"
                  : `/config profile ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
            onBack={() => setTab("Action")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<ConfigStepper />);
      return;
    }

    if (intent.kind === "exit-worktree") {
      const items = getExitWorktreePaletteItems().map(toModelSelectionItem);
      overlayId = overlay.pushOverlay(
        <ModelSelectionOverlay
          title="Exit Worktree"
          subtitle="Choose how to leave the current worktree."
          items={items}
          onSelect={(item) =>
            submitSlashSelection(`/exit-worktree ${item.value ?? item.label}`)}
          onClose={closeOverlay}
        />,
      );
    }
  }, [configStore, overlay, providerSlug, submit]);
}
