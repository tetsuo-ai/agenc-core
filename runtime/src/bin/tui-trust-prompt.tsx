import React, { useCallback } from "react";

import { TrustDialog } from "../permissions/trust/TrustDialog.js";
import { render as renderInk } from "../tui/ink.js";

export interface RenderProjectTrustPromptOptions {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

function ProjectTrustPromptApp(props: {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly finish: (accepted: boolean) => void;
}): React.ReactElement {
  const accept = useCallback(() => props.finish(true), [props]);
  const reject = useCallback(() => props.finish(false), [props]);
  return (
    <TrustDialog
      workspaceRoot={props.workspaceRoot}
      riskSources={props.riskSources}
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
  try {
    return await Promise.race([
      accepted,
      instance.waitUntilExit().then(() => false),
    ]);
  } finally {
    instance.unmount();
  }
}
