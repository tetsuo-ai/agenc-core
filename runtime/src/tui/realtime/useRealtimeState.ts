import { useEffect, useState } from "react";

import type { AgenCRealtimeTuiControls } from "./controller.js";
import { initialRealtimeTuiState, type RealtimeTuiState } from "./state.js";

export function useRealtimeState(
  controls: AgenCRealtimeTuiControls | undefined,
): RealtimeTuiState {
  const [state, setState] = useState<RealtimeTuiState>(
    () => controls?.getState() ?? initialRealtimeTuiState(),
  );

  useEffect(() => {
    if (controls === undefined) {
      setState(initialRealtimeTuiState());
      return;
    }
    return controls.subscribe(setState);
  }, [controls]);

  return state;
}
