// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";

import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { attachTaskErrorCommand } from "../commands.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { parseVitestFailures } from "./outputParsers.js";

const TAIL_BYTES = 48_000;

export function TestSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const dispatch = useWorkbenchDispatch();
  const task = useMemo(() => {
    if (workbench.selectedShellTaskId && tasks[workbench.selectedShellTaskId]) return tasks[workbench.selectedShellTaskId];
    return Object.values(tasks).find((item: any) => item.type === "local_bash") ?? null;
  }, [tasks, workbench.selectedShellTaskId]);
  const [tail, setTail] = useState("");
  const [selected, setSelected] = useState(0);
  const failures = useMemo(() => parseVitestFailures(tail), [tail]);
  const selectedFailure = failures[selected] ?? null;

  useEffect(() => {
    if (!task?.id) {
      setTail("");
      return;
    }
    let mounted = true;
    const readTail = () => {
      tailFile(getTaskOutputPath(task.id), TAIL_BYTES)
        .then((result) => {
          if (mounted) setTail(result.content);
        })
        .catch(() => {
          if (mounted) setTail("");
        });
    };
    readTail();
    const timer = task.status === "running" ? setInterval(readTail, 1_000) : null;
    timer?.unref?.();
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [task?.id, task?.status]);

  useRegisterKeybindingContext("Surface", focused);
  const jumpToSelectedFailure = () => {
    if (selectedFailure?.location) {
      dispatch({
        type: "openBuffer",
        path: selectedFailure.location.file,
        line: selectedFailure.location.line,
        focus: true,
      });
    }
  };
  useKeybindings(
    {
      "surface:up": () => setSelected((value) => Math.max(0, value - 1)),
      "surface:down": () => setSelected((value) => Math.min(Math.max(0, failures.length - 1), value + 1)),
      "surface:open": jumpToSelectedFailure,
      "surface:top": jumpToSelectedFailure,
      "surface:attach": () => {
        if (task?.id && selectedFailure?.location) {
          dispatch(attachTaskErrorCommand({
            taskId: task.id,
            file: selectedFailure.location.file,
            line: selectedFailure.location.line,
            label: selectedFailure.name,
          }));
        }
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (!task) return <EmptySurface title="TEST" message="No test task selected" />;

  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="TEST" detail={`${failures.length} failure${failures.length === 1 ? "" : "s"} - g/enter edit - @ attach`} focused={focused} />
      {failures.length === 0 ? (
        <Text dimColor wrap="truncate-end">No parsed test failures in the selected task output.</Text>
      ) : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {failures.map((failure, index) => (
          <Text key={failure.id} color={index === selected ? "suggestion" : undefined} wrap="truncate-end">
            {failure.location ? `${failure.location.file}:${failure.location.line} ` : ""}
            {failure.name}
          </Text>
        ))}
      </Box>
      {selectedFailure ? <Text dimColor wrap="truncate-end">{selectedFailure.message}</Text> : null}
    </Box>
  );
}
