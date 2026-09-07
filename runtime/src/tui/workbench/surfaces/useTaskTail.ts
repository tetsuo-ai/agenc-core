import { useEffect, useState } from "react";

import { tailFile } from "../../../utils/fsOperations.js";
import { logError } from "../../../utils/log.js";
import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";

/** Keep task output visible while a status change triggers its final read. */
export function useTaskTail(
  taskId: string | null | undefined,
  status: string | undefined,
  maxBytes: number,
): string {
  const [tail, setTail] = useState<{
    readonly taskId: string | null;
    readonly content: string;
  }>({ taskId: null, content: "" });

  useEffect(() => {
    const id = taskId || null;
    setTail((current) =>
      current.taskId === id ? current : { taskId: id, content: "" },
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
        if (active) setTail({ taskId: id, content: result.content });
      } catch (error) {
        // Retain the last successful tail after a transient disk failure.
        if (active) logError(error);
      } finally {
        reading = false;
      }
    };

    void readTail();
    const timer = status === "running" ? setInterval(readTail, 1_000) : null;
    timer?.unref?.();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [taskId, status, maxBytes]);

  // Hide a previous task's output during the render before effect cleanup.
  return tail.taskId === taskId ? tail.content : "";
}
