import { useEffect, useState } from "react";

import { tailFile } from "../../../utils/fsOperations.js";
import { logError } from "../../../utils/log.js";
import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";

interface TaskTail {
  readonly content: string;
  readonly error: string | null;
}

/** Keep task output visible while a status change triggers its final read. */
export function useTaskTail({
  taskId,
  status,
  maxBytes,
  pollIntervalMs,
}: {
  readonly taskId: string | null | undefined;
  readonly status: string | undefined;
  readonly maxBytes: number;
  readonly pollIntervalMs: number;
}): TaskTail {
  const [tail, setTail] = useState<{
    readonly taskId: string | null;
  } & TaskTail>({ taskId: null, content: "", error: null });

  useEffect(() => {
    const id = taskId || null;
    setTail((current) =>
      current.taskId === id ? current : { taskId: id, content: "", error: null },
    );
    if (!id) return;

    let active = true;
    let reading = false;
    const readTail = async () => {
      // A slow read must not accumulate overlapping polls or reorder output.
      if (!active || reading) return;
      reading = true;
      try {
        const result = await tailFile(getTaskOutputPath(id), maxBytes);
        if (active) {
          setTail({ taskId: id, content: result.content, error: null });
        }
      } catch (error) {
        // Retain the last successful tail after a transient disk failure.
        if (active) {
          setTail((current) => ({
            taskId: id,
            content: current.taskId === id ? current.content : "",
            error: error instanceof Error ? error.message : String(error),
          }));
          logError(error);
        }
      } finally {
        reading = false;
      }
    };

    void readTail();
    const timer = status === "running" ? setInterval(readTail, pollIntervalMs) : null;
    timer?.unref?.();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, status, maxBytes, pollIntervalMs]);

  // Hide a previous task's output during the render before effect cleanup.
  return tail.taskId === taskId ? tail : { content: "", error: null };
}
