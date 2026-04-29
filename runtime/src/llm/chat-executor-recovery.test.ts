import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRecoveryHints,
  inferRecoveryHint,
  preflightStaleCopiedCmakeHarnessInvocation,
} from "./chat-executor-recovery.js";

describe("chat-executor-recovery", () => {

  it("redirects long-running desktop shell work to structured process tools", () => {
    const hint = inferRecoveryHint({
      name: "desktop.bash",
      args: {
        command: "npm run dev",
      },
      result: JSON.stringify({
        error:
          'Command "npm run dev" is a long-running server process and is likely to timeout in foreground mode. Start it in background (append `&`) and then verify with curl or logs.',
      }),
      isError: false,
      durationMs: 22,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("desktop-bash-background-process-shape");
    expect(hint?.message).toContain("desktop.process_start");
    expect(hint?.message).toContain("desktop.process_status");
    expect(hint?.message).toContain("desktop.process_stop");
  });

  it("redirects failed raw docker shell attempts to durable sandbox handles", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "docker run node:20-slim npm test",
      },
      result: JSON.stringify({
        error: "Command docker is not allowlisted on system.bash.",
      }),
      isError: true,
      durationMs: 7,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-sandbox-handle");
    expect(hint?.message).toContain("system.sandboxStart");
    expect(hint?.message).toContain("system.sandboxJobStart");
  });

  it("tells the model to ask for required input instead of retrying requires_input tools", () => {
    const hint = inferRecoveryHint({
      name: "agenc.registerAgent",
      args: {
        capabilities: ["marketplace"],
      },
      result: JSON.stringify({
        status: "requires_input",
        code: "MULTIPLE_AGENT_REGISTRATIONS",
        error:
          "Multiple agent registrations found for signer wallet. Provide creatorAgentPda with one of the listed agentPda values.",
        agents: [
          {
            agentPda: "11111111111111111111111111111111",
          },
        ],
      }),
      isError: true,
      durationMs: 5,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe(
      "agenc.registerAgent-requires-input:multiple_agent_registrations",
    );
    expect(hint?.message).toContain('status: "requires_input"');
    expect(hint?.message).toContain("Do not retry the same tool call");
    expect(hint?.message).toContain("agentPda");
    expect(hint?.message).toContain("creatorAgentPda");
  });

  it("injects a recovery hint for stale CMake cache path mismatches", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "cd /tmp/agenc-shell/build && cmake .. && make",
      },
      result: JSON.stringify({
        exitCode: 1,
        stderr:
          "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
          'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n' +
          "Re-run cmake with a different source directory.\n",
      }),
      isError: true,
      durationMs: 61,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-cmake-cache-source-mismatch");
    expect(hint?.message).toContain("stale CMake cache");
    expect(hint?.message).toContain("Do not keep retrying");
    expect(hint?.message).toContain("build-agenc-fresh");
  });

  it("rewrites a simple stale copied build harness to direct fresh-build commands before execution", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-stale-cmake-"));
    mkdirSync(join(workspaceRoot, "build"), { recursive: true });
    mkdirSync(join(workspaceRoot, "tests"), { recursive: true });
    writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(test)\n");
    writeFileSync(
      join(workspaceRoot, "build", "CMakeCache.txt"),
      "CMAKE_HOME_DIRECTORY:INTERNAL=/home/tetsuo/git/stream-test/agenc-shell\n",
    );
    writeFileSync(
      join(workspaceRoot, "tests", "run_tests.sh"),
      "#!/bin/bash\nset -e\ncd build\ncmake .. && make\n",
    );

    const result = preflightStaleCopiedCmakeHarnessInvocation(
      "system.bash",
      {
        command: "bash",
        args: ["tests/run_tests.sh"],
        cwd: workspaceRoot,
      },
      workspaceRoot,
      [],
    );

    expect(result.rejectionError).toBeUndefined();
    expect(result.reasonKey).toBe("system-bash-cmake-stale-harness-rewritten");
    expect(result.args).toEqual({
      command:
        "cmake -S . -B build-agenc-fresh && cmake --build build-agenc-fresh",
      cwd: workspaceRoot,
    });
    expect(result.repairedFields).toEqual(["command", "args", "cwd"]);
  });

  it("rewrites direct configure commands that target the stale copied build directory", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-stale-cmake-"));
    mkdirSync(join(workspaceRoot, "build"), { recursive: true });
    writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(test)\n");
    writeFileSync(
      join(workspaceRoot, "build", "CMakeCache.txt"),
      "CMAKE_HOME_DIRECTORY:INTERNAL=/home/tetsuo/git/stream-test/agenc-shell\n",
    );

    const result = preflightStaleCopiedCmakeHarnessInvocation(
      "system.bash",
      {
        command: "cd",
        args: [join(workspaceRoot, "build"), "&&", "cmake", ".."],
        cwd: workspaceRoot,
      },
      workspaceRoot,
      [],
    );

    expect(result.rejectionError).toBeUndefined();
    expect(result.reasonKey).toBe("system-bash-cmake-stale-default-build-rewritten");
    expect(result.args).toEqual({
      command: "cmake",
      args: ["-S", workspaceRoot, "-B", join(workspaceRoot, "build-agenc-fresh")],
      cwd: workspaceRoot,
    });
    expect(result.repairedFields).toEqual(["command", "args", "cwd"]);
  });

  it("rewrites direct make calls from the stale copied build directory to the fresh build root", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-stale-cmake-"));
    mkdirSync(join(workspaceRoot, "build"), { recursive: true });
    writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(test)\n");
    writeFileSync(
      join(workspaceRoot, "build", "CMakeCache.txt"),
      "CMAKE_HOME_DIRECTORY:INTERNAL=/home/tetsuo/git/stream-test/agenc-shell\n",
    );

    const result = preflightStaleCopiedCmakeHarnessInvocation(
      "system.bash",
      {
        command: "make",
        cwd: join(workspaceRoot, "build"),
      },
      workspaceRoot,
      [],
    );

    expect(result.rejectionError).toBeUndefined();
    expect(result.reasonKey).toBe("system-bash-cmake-stale-default-build-rewritten");
    expect(result.args).toEqual({
      command: "cmake",
      args: ["--build", join(workspaceRoot, "build-agenc-fresh")],
      cwd: workspaceRoot,
    });
    expect(result.repairedFields).toEqual(["command", "args", "cwd"]);
  });

  it("fails closed when a stale copied build harness hardcodes build/ but cannot be safely rewritten", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-stale-cmake-"));
    mkdirSync(join(workspaceRoot, "build"), { recursive: true });
    mkdirSync(join(workspaceRoot, "tests"), { recursive: true });
    writeFileSync(join(workspaceRoot, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(test)\n");
    writeFileSync(
      join(workspaceRoot, "build", "CMakeCache.txt"),
      "CMAKE_HOME_DIRECTORY:INTERNAL=/home/tetsuo/git/stream-test/agenc-shell\n",
    );
    writeFileSync(
      join(workspaceRoot, "tests", "run_tests.sh"),
      "#!/bin/bash\nset -e\ncd build\ncmake .. && make\n./integration_suite.sh\n",
    );

    const result = preflightStaleCopiedCmakeHarnessInvocation(
      "system.bash",
      {
        command: "bash",
        args: ["tests/run_tests.sh"],
        cwd: workspaceRoot,
      },
      workspaceRoot,
      [],
    );

    expect(result.repairedFields).toEqual([]);
    expect(result.reasonKey).toBe("system-bash-cmake-stale-harness-rejected");
    expect(result.rejectionError).toContain("Refusing to invoke");
    expect(result.rejectionError).toContain("build-agenc-fresh");
  });

  it("injects a round-level recovery hint when stale CMake cleanup falls into denied rm", () => {
    const hints = buildRecoveryHints(
      [
        {
          name: "system.bash",
          args: {
            command: "bash tests/run_tests.sh",
          },
          result: JSON.stringify({
            exitCode: 1,
            stderr:
              "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
              'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n' +
              "Re-run cmake with a different source directory.\n",
          }),
          isError: true,
          durationMs: 11,
        },
        {
          name: "system.bash",
          args: {
            command: "rm /tmp/agenc-shell/build/CMakeCache.txt",
          },
          result: JSON.stringify({
            error: 'Command "rm" is denied',
          }),
          isError: true,
          durationMs: 1,
        },
      ],
      new Set(),
    );

    const hint = hints.find(
      (entry) => entry.key === "system-bash-cmake-cache-rebuild-in-fresh-dir",
    );
    expect(hint).toBeDefined();
    expect(hint?.message).toContain("destructive cleanup is blocked");
    expect(hint?.message).toContain("build-agenc-fresh");
    expect(hint?.message).toContain("run the equivalent compile/test verification command directly");
  });

  it("injects a round-level recovery hint when a stale repo harness is retried after a successful fresh build", () => {
    const hints = buildRecoveryHints(
      [
        {
          name: "system.bash",
          args: {
            command: "bash tests/run_tests.sh",
          },
          result: JSON.stringify({
            exitCode: 1,
            stderr:
              "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
              'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n',
          }),
          isError: true,
          durationMs: 38,
        },
        {
          name: "system.bash",
          args: {
            command: "cd build-fresh && cmake .. && make",
          },
          result: JSON.stringify({
            exitCode: 0,
            stdout:
              "-- Build files have been written to: /tmp/agenc-shell/build-fresh\n[100%] Built target agenc-shell\n",
            stderr: "",
          }),
          isError: false,
          durationMs: 119,
        },
      ],
      new Set(),
    );

    const hint = hints.find(
      (entry) => entry.key === "system-bash-cmake-stale-harness-after-fresh-build",
    );
    expect(hint).toBeDefined();
    expect(hint?.message).toContain("bash tests/run_tests.sh");
    expect(hint?.message).toContain("build-fresh");
    expect(hint?.message).toContain("explicit writable target");
  });

  it("injects the stale harness hint regardless of whether the fresh build succeeded earlier in the round", () => {
    const hints = buildRecoveryHints(
      [
        {
          name: "system.bash",
          args: {
            command: "cmake -S . -B build-agenc-fresh && cmake --build build-agenc-fresh",
          },
          result: JSON.stringify({
            exitCode: 0,
            stdout:
              "-- Build files have been written to: /tmp/agenc-shell/build-agenc-fresh\n[100%] Built target agenc-shell\n",
            stderr: "",
          }),
          isError: false,
          durationMs: 151,
        },
        {
          name: "system.bash",
          args: {
            command: "bash tests/run_tests.sh",
          },
          result: JSON.stringify({
            exitCode: 1,
            stderr:
              "Running tests...\n" +
              "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
              'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n',
          }),
          isError: true,
          durationMs: 63,
        },
      ],
      new Set(),
    );

    const hint = hints.find(
      (entry) => entry.key === "system-bash-cmake-stale-harness-after-fresh-build",
    );
    expect(hint).toBeDefined();
    expect(hint?.message).toContain("build-agenc-fresh");
    expect(hint?.message).toContain("Continue verification directly");
  });

  it("carries the stale harness hint across rounds when a later split-shell retry falls back into run_tests.sh", () => {
    const history = [
      {
        name: "system.bash",
        args: {
          command: "cmake",
          args: ["-S", ".", "-B", "build-new", "&&", "cmake", "--build", "build-new"],
        },
        result: JSON.stringify({
          exitCode: 0,
          stdout:
            "-- Build files have been written to: /tmp/agenc-shell/build-new\n[100%] Built target agenc-shell\n",
          stderr: "",
        }),
        isError: false,
        durationMs: 144,
      },
      {
        name: "system.bash",
        args: {
          command: "cd",
          args: [
            "/tmp/agenc-shell",
            "&&",
            "chmod",
            "+x",
            "tests/run_tests.sh",
            "&&",
            "./tests/run_tests.sh",
          ],
        },
        result: JSON.stringify({
          exitCode: 1,
          stderr:
            "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
            'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n',
        }),
        isError: true,
        durationMs: 72,
      },
    ] as const;

    const hints = buildRecoveryHints(
      history.slice(-1),
      new Set(),
      history,
    );

    const hint = hints.find(
      (entry) => entry.key === "system-bash-cmake-stale-harness-after-fresh-build",
    );
    expect(hint).toBeDefined();
    expect(hint?.message).toContain("build-new");
    expect(hint?.message).toContain("bash tests/run_tests.sh");
  });

  it("pins subsequent rebuilds to the established fresh build dir after a stale CMake cache is repaired", () => {
    const history = [
      {
        name: "system.bash",
        args: {
          command: "cd /tmp/agenc-shell/build && cmake .. && make",
        },
        result: JSON.stringify({
          exitCode: 1,
          stderr:
            "CMake Error: The current CMakeCache.txt directory /tmp/agenc-shell/build/CMakeCache.txt is different than the directory /home/tetsuo/git/stream-test/agenc-shell/build where CMakeCache.txt was created.\n" +
            'CMake Error: The source "/tmp/agenc-shell/CMakeLists.txt" does not match the source "/home/tetsuo/git/stream-test/agenc-shell/CMakeLists.txt" used to generate cache.\n',
        }),
        isError: true,
        durationMs: 41,
      },
      {
        name: "system.bash",
        args: {
          command: "cd /tmp/agenc-shell && cmake -S . -B build-fresh && make -C build-fresh",
        },
        result: JSON.stringify({
          exitCode: 0,
          stdout:
            "-- Build files have been written to: /tmp/agenc-shell/build-fresh\n[100%] Built target agenc-shell\n",
          stderr: "",
        }),
        isError: false,
        durationMs: 188,
      },
    ] as const;

    const hints = buildRecoveryHints(
      history.slice(-1),
      new Set(),
      history,
    );

    const hint = hints.find(
      (entry) => entry.key === "system-bash-cmake-use-established-fresh-build-dir",
    );
    expect(hint).toBeDefined();
    expect(hint?.message).toContain("build-fresh");
    expect(hint?.message).toContain("do not switch back to `build/`");
    expect(hint?.message).toContain("delete build directories with `rm`");
  });

  it("suggests a fresh build directory when rm is denied for stale build artifacts", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "rm /tmp/agenc-shell/build/CMakeCache.txt",
      },
      result: JSON.stringify({
        error: 'Command "rm" is denied',
      }),
      isError: true,
      durationMs: 1,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-command-denied-rm-build-artifacts");
    expect(hint?.message).toContain("build-agenc-fresh");
  });

  it("suggests configuring a fresh build directory when make runs in an unconfigured stale build dir", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "make",
        cwd: "/tmp/agenc-shell/build",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr: "make: *** No targets specified and no makefile found.  Stop.\n",
      }),
      isError: true,
      durationMs: 5,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-build-directory-not-configured");
    expect(hint?.message).toContain("build-agenc-fresh");
    expect(hint?.message).toContain("Do not keep retrying `make`");
  });

  it("injects a recovery hint for compiler diagnostics so the model repairs source instead of rerunning build", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "cd /tmp/agenc-shell && cmake -S . -B build && cmake --build build",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr:
          "/tmp/agenc-shell/src/lexer.c:54:44: error: macro \"ALLOC\" passed 2 arguments, but takes just 1\n" +
          "/tmp/agenc-shell/src/lexer.c:54:25: error: ‘ALLOC’ undeclared (first use in this function)\n",
      }),
      isError: true,
      durationMs: 184,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe(
      "system-bash-compiler-diagnostic:/tmp/agenc-shell/src/lexer.c:54:44",
    );
    expect(hint?.message).toContain("/tmp/agenc-shell/src/lexer.c:54:44");
    expect(hint?.message).toContain("Stop rerunning the same build command");
    expect(hint?.message).toContain("Read and edit the cited file");
  });

  it("injects a stronger recovery hint for header type-order compiler failures", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "bash tests/run_tests.sh",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr:
          "/tmp/agenc-shell/include/shell.h:27:5: error: unknown type name 'AstNode'\n" +
          "/tmp/agenc-shell/include/shell.h:28:5: error: unknown type name 'AstNode'\n",
      }),
      isError: true,
      durationMs: 211,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe(
      "system-bash-compiler-header-ordering:/tmp/agenc-shell/include/shell.h:27:5",
    );
    expect(hint?.message).toContain("header/type-ordering error");
    expect(hint?.message).toContain("AstNode");
    expect(hint?.message).toContain("forward declaration");
  });

  it("injects a stronger recovery hint for cross-file compiler interface drift", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "bash tests/run_tests.sh",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr:
          "/tmp/agenc-shell/src/parser.c:87:23: error: 'ASTNode' has no member named 'next'\n" +
          "/tmp/agenc-shell/src/parser.c:102:17: error: unknown type name 'Redirect'; did you mean 'Redir'?\n" +
          "/tmp/agenc-shell/src/parser.c:133:21: error: 'TOK_REDIRECT_IN' undeclared (first use in this function); did you mean 'TOK_REDIR_IN'?\n",
      }),
      isError: true,
      durationMs: 233,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe(
      "system-bash-compiler-interface-drift:/tmp/agenc-shell/src/parser.c:87:23",
    );
    expect(hint?.message).toContain("cross-file interface drift");
    expect(hint?.message).toContain("Redir");
    expect(hint?.message).toContain("shared type surface");
    expect(hint?.message).toContain("one coherent repair pass");
  });

  it("injects a recovery hint when a repo script is run from the wrong cwd and shell stderr reports a path failure", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "cd /tmp/agenc-shell/tests && bash run_tests.sh",
      },
      result: JSON.stringify({
        exitCode: 0,
        stdout: "Running tests...\nCompilation test passed\n",
        stderr:
          "run_tests.sh: line 6: cd: build: No such file or directory\n",
      }),
      isError: false,
      durationMs: 263,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-shell-execution-anomaly");
    expect(hint?.message).toContain("stderr even though the outer process returned success");
    expect(hint?.message).toContain("bash tests/run_tests.sh");
  });

  it("flags heredoc commands that put a conjunction on a fresh line", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command:
          "cd /tmp/demo && cat > package.json << 'EOF'\n" +
          "{\n  \"name\": \"demo\"\n}\n" +
          "EOF\n" +
          " && cat package.json\n",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr:
          "/tmp/agenc-sh-1234.sh: line 5: syntax error near unexpected token `&&'\n" +
          "/tmp/agenc-sh-1234.sh: line 5: ` && cat package.json'\n",
      }),
      isError: true,
      durationMs: 18,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-heredoc-conjunction-shape");
    expect(hint?.message).toContain("system.writeFile");
    expect(hint?.message).toContain("separate tool call");
  });

  it("redirects timed-out Vitest watch mode to single-run execution", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["test"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "> vitest\n\n FAIL  Tests failed. Watching for file changes...\n       press h to show help, press q to quit\n",
        stderr: "Error: No path found",
      }),
      isError: false,
      durationMs: 30_000,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-watch-mode");
    expect(hint?.message).toContain("vitest run");
    expect(hint?.message).toContain("CI=1 npm test");
  });

  it("redirects timed-out non-watch tests to source inspection instead of retry flailing", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm run test --workspace=@signal-cartography/core",
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "\n> @signal-cartography/core@1.0.0 test\n> vitest run\n\n\n RUN  v1.6.1 /workspace/signal-cartography/packages/core\n\n",
        stderr: 'Command "npm run test --workspace=@signal-cartography/core" failed',
      }),
      isError: true,
      durationMs: 30_053,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-timeout");
    expect(hint?.message).toContain("likely hung");
    expect(hint?.message).toContain("Inspect the authored source and tests");
    expect(hint?.message).toContain("Do not keep retrying");
  });

  it("treats direct node execution of compiled test artifacts as a timed-out test run", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "node",
        args: ["packages/core/dist/test/index.test.js"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "Running core tests...\nBFS test passed, cost: 3\nUnreachable test passed\n",
        stderr: "Command failed: node packages/core/dist/test/index.test.js\n",
      }),
      isError: true,
      durationMs: 30_006,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-timeout");
    expect(hint?.message).toContain("likely hung");
    expect(hint?.message).toContain("Inspect the authored source and tests");
  });

  it("flags unsupported Vitest threads flags and points to the supported pool option", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npx vitest run packages/core/src/index.test.ts --no-threads",
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          "CACError: Unknown option `--threads`\n    at Command.checkUnknownOptions (...)",
      }),
      isError: true,
      durationMs: 203,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-vitest-unsupported-threads-flag");
    expect(hint?.message).toContain("--no-threads");
    expect(hint?.message).toContain("--pool=<threads|forks>");
    expect(hint?.message).toContain("vitest run");
  });

  it("flags missing project-local binaries without misclassifying them as shell builtins", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "tsc",
        args: ["--noEmit"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr: "spawn tsc ENOENT",
      }),
      isError: true,
      durationMs: 9,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-missing-command:tsc");
    expect(hint?.message).toContain("`npx tsc`");
    expect(hint?.message).not.toContain("Shell builtins");
  });

  it("flags unsupported workspace protocol failures as host tooling constraints", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["install"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\n',
      }),
      isError: true,
      durationMs: 412,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-workspace-protocol-unsupported");
    expect(hint?.message).toContain("workspace:*");
    expect(hint?.message).toContain("rerun `npm install`");
  });

  it("flags repo-local verification harness shadow copies and redirects to direct bounded verification", () => {
    const hint = inferRecoveryHint({
      name: "system.writeFile",
      args: {
        path: "/tmp/agenc-shell/tests/run_tests_fresh.sh",
        content: "#!/bin/bash\ncmake -S . -B build-agenc-fresh && cmake --build build-agenc-fresh\n",
      },
      result: JSON.stringify({
        error:
          'Delegated write path "/tmp/agenc-shell/tests/run_tests_fresh.sh" rewrites a repo-local verification harness without explicitly owning it as a writable target',
      }),
      isError: true,
      durationMs: 2,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.writeFile-repo-local-verification-harness");
    expect(hint?.message).toContain("run_tests_fresh.sh");
    expect(hint?.message).toContain("Do not edit `tests/run_tests.sh`");
    expect(hint?.message).toContain("equivalent bounded verification commands directly");
  });

  it("flags interactive CLI verification runs that only return banner or prompt text", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command:
          'echo "echo hello world" | timeout 10s ./build-fresh/agenc-shell 2>/dev/null | tail -n 3 | head -n 1',
      },
      result: JSON.stringify({
        exitCode: 0,
        stdout: "Agenc Shell\n> \n> ",
        stderr: "",
        timedOut: false,
        durationMs: 56,
      }),
      isError: false,
      durationMs: 56,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-interactive-cli-verification-output-gap");
    expect(hint?.message).toContain("banner or prompt text");
    expect(hint?.message).toContain("tail");
    expect(hint?.message).toContain("explicit `exit`");
    expect(hint?.message).toContain("strip fixed prompt prefixes");
  });

  it("does not flag interactive CLI verification when prompt-prefixed output still carries a semantic payload", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: 'echo "pwd" | timeout 10s ./build-fresh/agenc-shell 2>/dev/null',
      },
      result: JSON.stringify({
        exitCode: 0,
        stdout: "Agenc Shell\n> /tmp/agenc-shell\n> ",
        stderr: "",
        timedOut: false,
        durationMs: 55,
      }),
      isError: false,
      durationMs: 55,
    });

    expect(hint).toBeUndefined();
  });

  it("flags timeout-wrapped shell assignments that hide a broken verification probe behind exit code 0", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command:
          "cd /tmp/agenc-shell && timeout 10s output=$(echo 'pwd' | ./build-fresh/agenc-shell 2>/dev/null | tail -n 2 | head -n 1 | sed 's/^> //'); expected=$(pwd); if [ \"$output\" = \"$expected\" ]; then echo 'pwd test passed'; else echo 'pwd test failed'; fi",
      },
      result: JSON.stringify({
        exitCode: 0,
        stdout: "pwd test failed\n",
        stderr:
          "timeout: failed to run command ‘output=/tmp/agenc-shell’: No such file or directory\n",
        timedOut: false,
        durationMs: 54,
      }),
      isError: false,
      durationMs: 54,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-timeout-assignment-misuse");
    expect(hint?.message).toContain("timeout 10s output=$(...)");
    expect(hint?.message).toContain("explicit `exit`");
    expect(hint?.message).toContain("tail`/`head`");
  });

  it("flags recursive npm install lifecycle scripts before they burn the turn budget", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["install"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "\n> maze-forge-ts@0.1.0 install\n> npm install\n\n" +
          "\n> maze-forge-ts@0.1.0 install\n> npm install\n",
        stderr: "Command failed: npm install\n",
      }),
      isError: true,
      durationMs: 30_000,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-recursive-npm-install-lifecycle");
    expect(hint?.message).toContain("recursive `install` script");
    expect(hint?.message).toContain("rerun `npm install`");
  });

  it("flags local package imports that point at missing dist output", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npx",
        args: ["tsx", "packages/cli/src/cli.ts", "demo-map.txt"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '/workspace/demo/node_modules/@terrain-router/core/dist/index.js' imported from /workspace/demo/packages/cli/src/cli.ts\n",
      }),
      isError: true,
      durationMs: 209,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-local-package-dist-missing");
    expect(hint?.message).toContain("dist/*");
    expect(hint?.message).toContain("Build the dependency package first");
  });

  it("flags direct-mode wildcard operands that rely on shell glob expansion", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "ls",
        args: ["packages/core/dist/*.d.ts"],
      },
      result: JSON.stringify({
        exitCode: 2,
        stdout: "",
        stderr:
          "ls: cannot access 'packages/core/dist/*.d.ts': No such file or directory\n",
      }),
      isError: true,
      durationMs: 6,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-literal-glob-operand");
    expect(hint?.message).toContain("does not expand shell globs");
    expect(hint?.message).toContain("find");
    expect(hint?.message).toContain("shell mode");
  });

});
