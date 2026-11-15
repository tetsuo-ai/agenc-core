import { createRequire } from "node:module";
import type {
  IPty,
  IPtyForkOptions,
  IWindowsPtyForkOptions,
} from "node-pty";

const require = createRequire(import.meta.url);

export type { IPty };

export interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ): IPty;
}

export function loadPtyFrom(
  requireFn: (id: string) => unknown,
  platform: NodeJS.Platform = process.platform,
): PtyModule {
  let pty: PtyModule;
  try {
    pty = requireFn("node-pty") as PtyModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PTY support is required but node-pty could not be loaded under ${process.version}. Run npm install in the runtime package and ensure native build tools are available. ${detail}`,
    );
  }
  if (platform === "win32") quietConsoleListAgent(requireFn);
  return pty;
}

const QUIET_CONSOLE_LIST = Symbol.for("agenc.nodePty.quietConsoleList");
/** node-pty's own wait for its console list agent. */
const CONSOLE_LIST_TIMEOUT_MS = 5_000;

interface ConsoleListAgentPrototype {
  _innerPid?: number;
  _getConsoleProcessList?: (this: ConsoleListAgentPrototype) => Promise<number[]>;
  [QUIET_CONSOLE_LIST]?: true;
}

/**
 * node-pty's ConPTY kill() forks conpty_console_list_agent to list the
 * processes attached to the console. That agent loads
 * conpty_console_list.node, which Windows Smart App Control refuses (an
 * unsigned file without reputation). The fork then prints the load error
 * into AgenC's stderr and dies, and node-pty waits 5 s before it kills only
 * the shell. AgenC ends Windows PTY trees with taskkill /T itself and calls
 * node-pty's kill() only as a fallback, so keep the agent where it works, but
 * run it without inherited output and stop waiting as soon as it fails.
 */
export function quietConsoleListAgent(requireFn: (id: string) => unknown): boolean {
  let prototype: ConsoleListAgentPrototype | undefined;
  let agentPath: string;
  try {
    const agentModule = requireFn("node-pty/lib/windowsPtyAgent") as {
      WindowsPtyAgent?: { prototype?: ConsoleListAgentPrototype };
    };
    prototype = agentModule.WindowsPtyAgent?.prototype;
    agentPath = require.resolve("node-pty/lib/conpty_console_list_agent");
  } catch {
    return false;
  }
  if (prototype === undefined || typeof prototype._getConsoleProcessList !== "function") return false;
  if (prototype[QUIET_CONSOLE_LIST] === true) return true;
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  prototype._getConsoleProcessList = function getConsoleProcessList(this: ConsoleListAgentPrototype) {
    const innerPid = this._innerPid ?? 0;
    return new Promise<number[]>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (list: number[]): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(list);
      };
      let agent: import("node:child_process").ChildProcess;
      try {
        agent = childProcess.fork(agentPath, [String(innerPid)], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      } catch {
        done([innerPid]);
        return;
      }
      agent.on("message", (message: { consoleProcessList?: unknown }) => {
        const list = message?.consoleProcessList;
        done(Array.isArray(list) && list.every((pid) => Number.isInteger(pid)) ? (list as number[]) : [innerPid]);
      });
      agent.on("error", () => done([innerPid]));
      // A failed load exits non-zero at once; a working agent sends its list
      // first and exits 0, so only a failure ends the wait early.
      agent.on("exit", (code) => {
        if (code !== 0) done([innerPid]);
      });
      timer = setTimeout(() => {
        try {
          agent.kill();
        } catch {
          // Already gone.
        }
        done([innerPid]);
      }, CONSOLE_LIST_TIMEOUT_MS);
      timer.unref?.();
    });
  };
  prototype[QUIET_CONSOLE_LIST] = true;
  return true;
}

export function loadPty(): PtyModule {
  return loadPtyFrom(require);
}
