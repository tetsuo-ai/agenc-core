import "../bootstrap/node-env.js";
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
        settle?.(value);
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
