from pathlib import Path
r=Path('/private/tmp/light-ultra/core-speed/runtime')
p=r/'src/unified-exec/types.ts';s=p.read_text().replace('export interface UnifiedExecManagerOptions {','export interface UnifiedExecManagerOptions {\n  /** Light: settle drained pipes promptly; descendant containment still runs. */\n  readonly settleOnStreamClose?: boolean;\n  /** Light command responses retain the bounded tail of each stream. */\n  readonly tailOutput?: boolean;');p.write_text(s)
p=r/'src/unified-exec/process-manager.ts';s=p.read_text();needle='function createResult(params: {'
s=s.replace(needle,'''function truncateTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = `[... earlier output omitted; ${text.length} original chars ...]\\n`;
  const tailChars = Math.max(0, maxChars - marker.length);
  return { text: marker.slice(0, maxChars) + (tailChars > 0 ? text.slice(-tailChars) : ""), truncated: true };
}

function createResult(params: {
  readonly tailOutput?: boolean;''')
s=s.replace('  const stdout = truncateHeadTail(params.stdout, maxChars);\n  const stderr = truncateHeadTail(params.stderr, maxChars);','  const truncate = params.tailOutput === true ? truncateTail : truncateHeadTail;\n  const stdout = truncate(params.stdout, maxChars);\n  const stderr = truncate(params.stderr, maxChars);')
s=s.replace('  private readonly shellPath: string;','  private readonly shellPath: string;\n  private readonly settleOnStreamClose: boolean;\n  private readonly tailOutput: boolean;')
s=s.replace('    this.cwd = options.cwd ?? process.cwd();','    this.cwd = options.cwd ?? process.cwd();\n    this.settleOnStreamClose = options.settleOnStreamClose === true;\n    this.tailOutput = options.tailOutput === true;')
s=s.replace('createResult({\n      stdout', 'createResult({\n      tailOutput: this.tailOutput,\n      stdout')
s=s.replace('    let settlementStarted = false;','    let settlementStarted = false;\n    let settlementTimer: ReturnType<typeof setTimeout> | undefined;\n    let pendingSettlement: { state: ExitState; error?: Error } | undefined;')
s=s.replace('''      settlementStarted = true;
      setTimeout(() => {
        void terminateProcessTreeAndReport(child, {''','''      settlementStarted = true;
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      void terminateProcessTreeAndReport(child, {''')
s=s.replace('''        );
      }, 20).unref?.();
    };
    child.on("exit", (code, signal) => {
      settleContainedProcess({ exitCode: code, signal });
    });
    child.on("error", (error) => {
      settleContainedProcess({ exitCode: 1 }, error);
    });''','''        );
    };
    const scheduleSettlement = (state: ExitState, error?: Error): void => {
      if (settlementStarted || settlementTimer !== undefined) return;
      pendingSettlement = { state, ...(error !== undefined ? { error } : {}) };
      // Keep the fallback for descendants holding pipes open after leader exit.
      settlementTimer = setTimeout(() => settleContainedProcess(state, error), 20);
      settlementTimer.unref?.();
    };
    child.on("exit", (code, signal) => {
      scheduleSettlement({ exitCode: code, signal });
    });
    child.on("error", (error) => {
      scheduleSettlement({ exitCode: 1 }, error);
    });
    if (this.settleOnStreamClose) {
      child.on("close", (code, signal) => {
        // Node emits close after both output streams drain. Containment is still
        // mandatory, including the failure path that poisons sandbox authority.
        settleContainedProcess(pendingSettlement?.state ?? { exitCode: code, signal }, pendingSettlement?.error);
      });
    }''')
p.write_text(s)
p=r/'src/bin/bootstrap.ts';s=p.read_text().replace('const unifiedExecManager = new UnifiedExecProcessManager({\n    cwd:', 'const unifiedExecManager = new UnifiedExecProcessManager({\n    ...(runtimeOptions.lightMode === true ? { settleOnStreamClose: true, tailOutput: true } : {}),\n    cwd:');p.write_text(s)
p=r/'src/tool-registry.ts';s=p.read_text().replace('new UnifiedExecProcessManager({ cwd: options.workspaceRoot });','new UnifiedExecProcessManager({ cwd: options.workspaceRoot, ...(options.lightMode === true ? { settleOnStreamClose: true, tailOutput: true } : {}) });');p.write_text(s)
# A failed timer refresh must stay dirty so list/close barriers can retry it.
p=r/'src/thread-store/store.ts';s=p.read_text();s=s.replace('''      this.pendingIndexes.delete(rolloutPath);
    }
    backfillRolloutFile({''','''    }
    backfillRolloutFile({''');s=s.replace('''        this.pendingIndexes.delete(rolloutPath);
        if (this.closed''','''        if (this.closed''')
# Insert delete at the end of this method only.
start=s.index('  private indexRolloutFile(');end=s.index('\n  private ',start+5);part=s[start:end];i=part.rfind('\n  }');part=part[:i]+'\n    this.pendingIndexes.delete(rolloutPath);'+part[i:];s=s[:start]+part+s[end:];p.write_text(s)
p=r/'tests/unified-exec/process-manager.test.ts';s=p.read_text();s=s.replace('''test("contains a detached delayed descendant before the operation lifetime settles", async () => {''','''test.each([false, true])("contains a detached delayed descendant before the operation lifetime settles (drained=%s)", async (settleOnStreamClose) => {''')
start=s.index('test.each([false, true])');end=s.index('\n  test(',start+5);part=s[start:end].replace('new UnifiedExecProcessManager({ cwd: root })','new UnifiedExecProcessManager({ cwd: root, settleOnStreamClose })');s=s[:start]+part+s[end:]
s+='''

describe("Light command results", () => {
  test("retains stream tails, exit status and total size after pipe drain", async () => {
    const manager = new UnifiedExecProcessManager({ tailOutput: true, settleOnStreamClose: true });
    try {
      const script = "process.stdout.write('FIRST'+'.'.repeat(5000)+'LAST');process.stderr.write('ERROR'+'.'.repeat(5000)+'FAIL');process.exitCode=7";
      const result = await manager.execCommand({ cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, max_output_tokens: 100, yield_time_ms: 1000 });
      expect(result.stdout).toContain("earlier output omitted");
      expect(result.stdout).toMatch(/LAST$/u);
      expect(result.stderr).toMatch(/FAIL$/u);
      expect(result.stdout).not.toContain("FIRST");
      expect(result.exitCode).toBe(7);
      expect(result.process_id).toBeUndefined();
      expect(result.truncated).toBe(true);
      expect(result.original_token_count).toBeGreaterThan(100);
    } finally { await manager.closeAll("test cleanup"); }
  });
});
''';p.write_text(s)
