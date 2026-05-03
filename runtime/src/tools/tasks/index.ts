export { createBackgroundTaskTools } from "./background.js";
export { createTaskBoardTools } from "./task-board.js";
export type { TaskToolOptions } from "./helpers.js";

import type { Tool } from "../types.js";
import { createBackgroundTaskTools } from "./background.js";
import { createTaskBoardTools } from "./task-board.js";
import type { TaskToolOptions } from "./helpers.js";

export function createTaskTools(opts: TaskToolOptions): readonly Tool[] {
  return [
    ...createTaskBoardTools(opts),
    ...createBackgroundTaskTools(),
  ];
}
