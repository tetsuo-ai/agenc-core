import type { ReactNode } from "react";
import type { AutoUpdaterResult } from "../../utils/autoUpdater.js";

/** Legacy upstream updater entry point. AgenC updates only through the
 * manifest service and the startup /update menu in App. */
export function AutoUpdaterWrapper(_props: {
  isUpdating: boolean;
  onChangeIsUpdating: (value: boolean) => void;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
}): ReactNode {
  return null;
}
