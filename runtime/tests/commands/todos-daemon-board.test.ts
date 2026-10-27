import { expect, it, vi } from "vitest";
import { todosCommand } from "../../src/commands/todos.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
const board = vi.hoisted(() => ({ listTasks: vi.fn() }));
vi.mock("../../src/utils/tasks.js", () => ({ listTasks: board.listTasks, getTaskListId: () => "canonical-board" }));
it("reads the daemon task board used by the running footer", async () => {
  board.listTasks.mockResolvedValue([{ id: "tw-pending", subject: "Finish invoice fixture", status: "pending" }]);
  const result = await todosCommand.execute({ session: { conversationId: "conv-real", services: {} }, cwd: "/workspace", home: "/home", argsRaw: "", appState: { getAppState: () => ({ todos: {} }) } } as unknown as SlashCommandContext);
  expect(result).toMatchObject({ kind: "text", text: expect.stringContaining("Finish invoice fixture") });
  expect(board.listTasks).toHaveBeenCalledExactlyOnceWith("canonical-board");
});
