import React, { useCallback } from "react";

import { TrustDialog } from "../permissions/trust/TrustDialog.js";
import { render as renderInk } from "../tui/ink.js";
import { CURSOR_HOME, ERASE_SCREEN } from "../tui/ink/termio/csi.js";

export interface RenderProjectTrustPromptOptions {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly bypassPermissionsRequested?: boolean;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

function ProjectTrustPromptApp(props: {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly bypassPermissionsRequested?: boolean;
  readonly finish: (accepted: boolean) => void;
}): React.ReactElement {
  const accept = useCallback(() => props.finish(true), [props]);
  const reject = useCallback(() => props.finish(false), [props]);
  return (
    <TrustDialog
      workspaceRoot={props.workspaceRoot}
      riskSources={props.riskSources}
      bypassPermissionsRequested={props.bypassPermissionsRequested}
      onAccept={accept}
      onReject={reject}
    />
  );
}

export async function renderProjectTrustPrompt(
  options: RenderProjectTrustPromptOptions,
): Promise<boolean> {
  let settle: ((accepted: boolean) => void) | null = null;
  const accepted = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const instance = await renderInk(
    <ProjectTrustPromptApp
      workspaceRoot={options.workspaceRoot}
      riskSources={options.riskSources}
      bypassPermissionsRequested={options.bypassPermissionsRequested}
      finish={(value) => {
        // Defer the resolve to the next macrotask. `finish` is called from
        // inside TrustDialog's in-flight `await onAccept()` handler; resolving
        // synchronously lets the outer race below unmount the ink tree while
        // that handler (and React's pending state commit) is still on the
        // stack, which intermittently deadlocked the render and left the
        // dialog frozen on "Accepting…". Deferring lets the dialog's submit
        // fully unwind before we tear the instance down.
        setImmediate(() => {
          settle?.(value);
        });
      }}
    />,
    {
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
      patchConsole: true,
      exitOnCtrlC: true,
    },
  );
  let result = false;
  try {
    result = await Promise.race([
      accepted,
      instance.waitUntilExit().then(() => false),
    ]);
    return result;
  } finally {
    instance.unmount();
    if (result && (options.stdout ?? process.stdout).isTTY) {
      (options.stdout ?? process.stdout).write(ERASE_SCREEN + CURSOR_HOME);
    }
  }
}
