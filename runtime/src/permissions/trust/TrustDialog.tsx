import React, { useCallback, useState } from "react";

export interface TrustDialogProps {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly onAccept: () => void | Promise<void>;
  readonly onReject: () => void | Promise<void>;
}

type TrustChoice = "trust" | "exit";

function eventName(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const raw =
    "name" in event
      ? (event as { readonly name?: unknown }).name
      : (event as { readonly key?: unknown }).key;
  return typeof raw === "string" ? raw : "";
}

export function TrustDialog(props: TrustDialogProps): React.ReactElement {
  const [choice, setChoice] = useState<TrustChoice>("exit");
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (next: TrustChoice = choice) => {
      if (pending) return;
      setPending(true);
      try {
        if (next === "trust") {
          await props.onAccept();
        } else {
          await props.onReject();
        }
      } finally {
        setPending(false);
      }
    },
    [choice, pending, props],
  );

  const onKeyDown = useCallback(
    (event: unknown) => {
      const name = eventName(event);
      if (name === "up" || name === "down" || name === "tab") {
        setChoice((current) => (current === "trust" ? "exit" : "trust"));
        return;
      }
      if (name === "return" || name === "enter") {
        void submit();
        return;
      }
      if (name === "escape") {
        void submit("exit");
      }
    },
    [submit],
  );

  const h = React.createElement;
  const option = (id: TrustChoice, label: string) =>
    h(
      "ink-text",
      {
        key: id,
        textStyles: { bold: choice === id },
      },
      `${choice === id ? ">" : " "} ${label}`,
    );

  return h(
    "ink-box",
    {
      autoFocus: true,
      tabIndex: 0,
      onKeyDown,
      style: {
        flexDirection: "column",
        paddingX: 1,
        paddingY: 1,
        gap: 1,
      },
    },
    h("ink-text", { textStyles: { bold: true } }, "Trust this project?"),
    h("ink-text", null, props.workspaceRoot),
    h(
      "ink-text",
      null,
      "AgenC can read files, edit files, and run commands in trusted projects.",
    ),
    props.riskSources && props.riskSources.length > 0
      ? h(
          "ink-box",
          { style: { flexDirection: "column" } },
          h("ink-text", { textStyles: { bold: true } }, "Project-local signals:"),
          ...props.riskSources.map((source) =>
            h("ink-text", { key: source }, `- ${source}`),
          ),
        )
      : null,
    h(
      "ink-box",
      { style: { flexDirection: "column" } },
      option("trust", pending ? "Accepting..." : "Yes, I trust this project"),
      option("exit", "No, exit"),
    ),
  );
}

export default TrustDialog;
