from pathlib import Path
r=Path('/private/tmp/light-ultra/core-context/runtime')
def edit(f,a,b):
 p=r/f;s=p.read_text();assert a in s,f;p.write_text(s.replace(a,b))
edit('src/tools/system/file-read.ts','const fileReadDescription = (sparse: boolean): string =>','const fileReadDescription = (sparse: boolean, defaultLines = DEFAULT_LINE_LIMIT): string =>')
edit('src/tools/system/file-read.ts','${DEFAULT_LINE_LIMIT} lines starting','${defaultLines} lines starting')
edit('src/tools/system/file-read.ts','  readonly maxTokens?: number;','  readonly maxTokens?: number;\n  /** Default plain-text line window; explicit offset/limit remain available. */\n  readonly defaultTextLineLimit?: number;')
edit('src/tools/system/file-read.ts','interface TextReadOpts {','interface TextReadOpts {\n  readonly announcePartial?: boolean;')
edit('src/tools/system/file-read.ts','    content: formatNumbered(sliced.content, sliced.startLine, opts.sparseLineNumbers),','    content: formatNumbered(sliced.content, sliced.startLine, opts.sparseLineNumbers) +\n      (opts.announcePartial && sliced.isPartial\n        ? `\\n[Showing lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines}. Use offset/limit for other lines.]` : ""),')
edit('src/tools/system/file-read.ts','description: fileReadDescription(sparseLineNumbers),','description: fileReadDescription(sparseLineNumbers, config.defaultTextLineLimit),')
# Only plain text changes; PDFs/images/notebooks keep their established handling.
edit('src/tools/system/file-read.ts','''              offset,
              limit,
              displayPath: filePath,
              readGuard,
            },
            sessionId,
            boundRead,
            true,''','''              offset,
              limit: limit ?? config.defaultTextLineLimit,
              announcePartial: config.defaultTextLineLimit !== undefined,
              displayPath: filePath,
              readGuard,
            },
            sessionId,
            boundRead,
            true,''')
for f,needle in [('src/tools/system/exec-command.ts','export interface ExecCommandToolConfig extends BashToolConfig {'),('src/tools/system/write-stdin.ts','export interface WriteStdinToolConfig {')]:
 edit(f,needle,needle+'\n  /** Default result budget; explicit max_output_tokens takes precedence. */\n  readonly defaultMaxOutputTokens?: number;')
 edit(f,'''          ...(asNumber(args.max_output_tokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) }
            : {}),''','''          ...((asNumber(args.max_output_tokens) ?? config?.defaultMaxOutputTokens) !== undefined
            ? { max_output_tokens: asNumber(args.max_output_tokens) ?? config?.defaultMaxOutputTokens }
            : {}),''')
edit('src/tool-registry.ts','''    createExecCommandTool({
      cwd: options.workspaceRoot,''','''    createExecCommandTool({
      cwd: options.workspaceRoot,
      ...(options.lightMode === true ? { defaultMaxOutputTokens: 2000 } : {}),''')
edit('src/tool-registry.ts','''    createWriteStdinTool({
      cwd: options.workspaceRoot,''','''    createWriteStdinTool({
      cwd: options.workspaceRoot,
      ...(options.lightMode === true ? { defaultMaxOutputTokens: 2000 } : {}),''')
edit('src/tool-registry.ts','''    createFileReadTool({
      allowedPaths: [options.workspaceRoot],''','''    createFileReadTool({
      allowedPaths: [options.workspaceRoot],
      ...(options.lightMode === true ? { defaultTextLineLimit: 200 } : {}),''')
edit('src/tools/light-tool-presentation.ts','Read files. offset/limit are 1-indexed lines; display numbers may be sparse.','Read files. Text defaults to 200 lines; offset is 1-indexed and limit is a line count. Display numbers may be sparse.')
edit('src/tools/light-tool-presentation.ts','Run cmd in workdir. Time fields are milliseconds.','Run cmd in workdir. Time fields are milliseconds. Output defaults to 2000 tokens; max_output_tokens overrides.')
edit('src/tools/light-tool-presentation.ts','Poll a running exec_command session with chars empty,','Output defaults to 2000 tokens; max_output_tokens overrides. Poll a running exec_command session with chars empty,')
# The canonical Read description must reflect its configured default.
edit('tests/tool-registry.test.ts','''        expect(canonical.description).toBe(normal.tools.find(tool => tool.name === canonical.name)?.description);''','''        const normalDescription = normal.tools.find(tool => tool.name === canonical.name)?.description;
        expect(canonical.description).toBe(canonical.name === "FileRead"
          ? normalDescription?.replace("2000 lines starting", "200 lines starting") : normalDescription);''')
p=r/'tests/tools/system/file-read.test.ts';s=p.read_text();a='  test("offset without limit uses the default bounded window over the byte cap",';idx=s.index(a);s=s[:idx]+'''  test("a smaller default window announces omitted lines, permits continuation and preserves read state", async () => {
    const file = join(root, "bounded.txt");
    await writeFile(file, Array.from({ length: 260 }, (_, i) => `line-${i + 1}`).join("\\n"));
    const tool = createFileReadTool({ allowedPaths: [root], defaultTextLineLimit: 200 });
    const result = await tool.execute({ file_path: file, __agencSessionId: signSessionId(sessionId) });
    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({ numLines: 200, isPartial: true, totalLines: 260 });
    expect(result.content).toContain("Showing lines 1-200 of 260");
    expect(result.content).not.toContain("line-201");
    expect(hasSessionRead(sessionId, file)).toBe(true);
    const rest = await tool.execute({ file_path: file, offset: 201 });
    expect(rest.content).toContain("line-260");
    const explicit = await tool.execute({ file_path: file, limit: 300 });
    expect(explicit.metadata).toMatchObject({ numLines: 260, isPartial: false });
    expect(explicit.content).not.toContain("Showing lines");
    const normal = await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file });
    expect(normal.metadata?.numLines).toBe(260);
  });

'''+s[idx:];p.write_text(s)
# Test the real manager boundary receives the default and allows an explicit larger budget.
p=r/'tests/tools/system/exec-command.test.ts';s=p.read_text();idx=s.index('  // Live incident');s=s[:idx]+'''  test("configured output defaults reach the manager and explicit requests override them", async () => {
    const execCommand = vi.fn<UnifiedExecProcessManagerLike["execCommand"]>(async () => completedExecOutput("ok"));
    const manager: UnifiedExecProcessManagerLike = { maxTimeoutMs: 30_000, execCommand,
      writeStdin: vi.fn(async () => completedExecOutput("")), closeAll: vi.fn(async () => {}) };
    const tool = createExecCommandTool({ cwd: root, allowedPaths: [root], unifiedExecManager: manager, defaultMaxOutputTokens: 2000 });
    const first = await tool.execute({ cmd: "pwd" });
    expect(first.isError).toBeUndefined();
    expect(first.metadata?.exitCode).toBe(0);
    expect(first.effectDisposition).toBeDefined();
    expect(execCommand.mock.calls[0]?.[0].max_output_tokens).toBe(2000);
    await tool.execute({ cmd: "pwd", max_output_tokens: 7000 });
    expect(execCommand.mock.calls[1]?.[0].max_output_tokens).toBe(7000);
  });

'''+s[idx:];p.write_text(s)
p=r/'tests/tools/system/write-stdin.test.ts';s=p.read_text();s+='''\ntest("polling output defaults reach the manager and explicit requests override them", async () => {
  const writeStdin = vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, truncated: false } as ExecCommandToolOutput));
  const manager: UnifiedExecProcessManagerLike = { maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => undefined as never), writeStdin, closeAll: vi.fn(async () => {}) };
  const tool = bindExplicitDangerBoundary(createUnboundWriteStdinTool({ cwd: root, unifiedExecManager: manager, defaultMaxOutputTokens: 2000 }));
  await tool.execute({ session_id: 1, chars: "" });
  expect(writeStdin.mock.calls[0]?.[0]).toMatchObject({ max_output_tokens: 2000 });
  await tool.execute({ session_id: 1, chars: "", max_output_tokens: 7000 });
  expect(writeStdin.mock.calls[1]?.[0]).toMatchObject({ max_output_tokens: 7000 });
});
''';p.write_text(s)
