import "../bootstrap/node-env.js";
import React, { useCallback } from "react";

import { TrustDialog } from "../permissions/trust/TrustDialog.js";
import { WindowsSandboxDialog } from "../permissions/WindowsSandboxDialog.js";
import { render as renderInk } from "../tui/ink.js";
import type { ProjectTrustPromptOptions } from "./project-trust-preflight.js";
import type { WindowsSandboxPromptOptions } from "./windows-sandbox-choice.js";
import { CURSOR_HOME, ERASE_SCREEN } from "../tui/ink/termio/csi.js";

export type RenderProjectTrustPromptOptions = ProjectTrustPromptOptions;

type ProjectTrustDialogProps = Omit<
  ProjectTrustPromptOptions,
  "stdin" | "stdout" | "stderr"
>;

function ProjectTrustPromptApp(props: ProjectTrustDialogProps & {
  readonly finish: (accepted: boolean) => void;
}): React.ReactElement {
  const { finish, ...dialog } = props;
  const accept = useCallback(() => finish(true), [finish]);
  const reject = useCallback(() => finish(false), [finish]);
  return <TrustDialog {...dialog} onAccept={accept} onReject={reject} />;
}

export async function renderProjectTrustPrompt(
  options: RenderProjectTrustPromptOptions,
): Promise<boolean> {
  let settle: ((accepted: boolean) => void) | null = null;
  const accepted = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const { stdin, stdout, stderr, ...dialog } = options;
  const instance = await renderInk(
    <ProjectTrustPromptApp
      {...dialog}
      finish={(value) => {
        settle?.(value);
      }}
    />,
    {
      stdin: stdin ?? process.stdin,
      stdout: stdout ?? process.stdout,
      stderr: stderr ?? process.stderr,
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

function WindowsSandboxPromptApp(props: {
  readonly finish: (accepted: boolean) => void;
}): React.ReactElement {
  const { finish } = props;
  const accept = useCallback(() => finish(true), [finish]);
  const reject = useCallback(() => finish(false), [finish]);
  return <WindowsSandboxDialog onContinue={accept} onQuit={reject} />;
}

/** The Windows no-sandbox card; true when the user chose to continue. */
export async function renderWindowsSandboxPrompt(
  options: WindowsSandboxPromptOptions,
): Promise<boolean> {
  let settle: ((accepted: boolean) => void) | null = null;
  const accepted = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const stdout = options.stdout ?? process.stdout;
  const instance = await renderInk(
    <WindowsSandboxPromptApp
      finish={(value) => {
        settle?.(value);
      }}
    />,
    {
      stdin: options.stdin ?? process.stdin,
      stdout,
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
    if (result && stdout.isTTY) {
      stdout.write(ERASE_SCREEN + CURSOR_HOME);
    }
  }
}
