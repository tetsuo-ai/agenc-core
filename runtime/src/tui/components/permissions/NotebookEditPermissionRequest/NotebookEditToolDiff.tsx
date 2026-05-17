// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { relative } from 'path'
import { Suspense, use, useMemo, type ReactNode } from 'react'

import type {
  NotebookCellType,
  NotebookContent,
} from '../../../../types/notebook'
import { intersperse } from '../../../../utils/array.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getCwd } from '../../../../utils/cwd.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getPatchForDisplay } from '../../../../utils/diff.js' // upstream-import: keep target is owned by another Z-PURGE item
import { getFsImplementation } from '../../../../utils/fsOperations.js' // upstream-import: keep target is owned by another Z-PURGE item
import { safeParseJSON } from '../../../../utils/json.js' // upstream-import: keep target is owned by another Z-PURGE item
import { parseCellId } from '../../../../utils/notebook.js' // upstream-import: keep target is owned by another Z-PURGE item
import { Box, NoSelect, Text } from '../../../ink.js'
import { LoadingState } from '../../design-system/LoadingState'
import { StructuredDiff } from '../../diff/StructuredDiff'
import { HighlightedCode } from '../../markdown/HighlightedCode.js'

type Props = {
  notebook_path: string
  cell_id: string | undefined
  new_source: string
  cell_type?: NotebookCellType
  edit_mode?: string
  verbose: boolean
  width: number
}

type NotebookPreviewLoadResult =
  | { status: 'ok'; data: NotebookContent }
  | { status: 'error'; message: string }

type InnerProps = Props & {
  promise: Promise<NotebookPreviewLoadResult>
}

function notebookPreviewLabel(notebookPath: string, verbose: boolean): string {
  return verbose ? notebookPath : relative(getCwd(), notebookPath)
}

function normalizeDiffWidth(width: number): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  return Math.max(1, safeWidth)
}

export async function loadNotebookPreview(
  notebookPath: string,
): Promise<NotebookPreviewLoadResult> {
  try {
    const content = await getFsImplementation().readFile(notebookPath, {
      encoding: 'utf-8',
    })
    const parsed = safeParseJSON(content) as NotebookContent | null
    if (!parsed) {
      return {
        status: 'error',
        message: 'Could not parse notebook JSON.',
      }
    }

    return {
      status: 'ok',
      data: parsed,
    }
  } catch (error) {
    return {
      status: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Could not read notebook preview.',
    }
  }
}

function sourceForCell(
  notebookData: NotebookContent,
  cellId: string | undefined,
): string {
  if (!cellId) return ''

  const cellIndex = parseCellId(cellId)
  if (cellIndex !== undefined) {
    const indexedCell = notebookData.cells[cellIndex]
    if (!indexedCell) return ''
    return Array.isArray(indexedCell.source)
      ? indexedCell.source.join('')
      : indexedCell.source
  }

  const matchingCell = notebookData.cells.find(cell => cell.id === cellId)
  if (!matchingCell) return ''
  return Array.isArray(matchingCell.source)
    ? matchingCell.source.join('')
    : matchingCell.source
}

function NotebookEditToolDiffLoading({
  notebook_path,
  verbose,
}: Pick<Props, 'notebook_path' | 'verbose'>): ReactNode {
  return (
    <NotebookEditToolDiffFrame
      notebook_path={notebook_path}
      verbose={verbose}
      detail={<LoadingState message="Loading notebook preview..." dimColor={true} />}
    />
  )
}

function NotebookEditToolDiffError({
  notebook_path,
  verbose,
  message,
}: Pick<Props, 'notebook_path' | 'verbose'> & {
  message: string
}): ReactNode {
  return (
    <NotebookEditToolDiffFrame
      notebook_path={notebook_path}
      verbose={verbose}
      detail={
        <Box flexDirection="column">
          <Text color="error" bold={true}>
            Could not load notebook preview
          </Text>
          <Text dimColor={true}>{message}</Text>
        </Box>
      }
    />
  )
}

function NotebookEditToolDiffFrame({
  notebook_path,
  verbose,
  detail,
}: Pick<Props, 'notebook_path' | 'verbose'> & {
  detail: ReactNode
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Box paddingBottom={1} flexDirection="column">
          <Text bold={true}>{notebookPreviewLabel(notebook_path, verbose)}</Text>
        </Box>
        {detail}
      </Box>
    </Box>
  )
}

export function NotebookEditToolDiff(props: Props): ReactNode {
  const notebookDataPromise = useMemo(
    () => loadNotebookPreview(props.notebook_path),
    [props.notebook_path],
  )

  return (
    <Suspense
      fallback={
        <NotebookEditToolDiffLoading
          notebook_path={props.notebook_path}
          verbose={props.verbose}
        />
      }
    >
      <NotebookEditToolDiffInner {...props} promise={notebookDataPromise} />
    </Suspense>
  )
}

function NotebookEditToolDiffInner({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode = 'replace',
  verbose,
  width,
  promise,
}: InnerProps): ReactNode {
  const loadResult = use(promise)

  if (loadResult.status === 'error') {
    return (
      <NotebookEditToolDiffError
        notebook_path={notebook_path}
        verbose={verbose}
        message={loadResult.message}
      />
    )
  }

  const oldSource = sourceForCell(loadResult.data, cell_id)
  const hunks =
    edit_mode === 'insert' || edit_mode === 'delete'
      ? null
      : getPatchForDisplay({
          filePath: notebook_path,
          fileContents: oldSource,
          edits: [
            {
              old_string: oldSource,
              new_string: new_source,
              replace_all: false,
            },
          ],
          ignoreWhitespace: false,
        })
  const editTypeDescription =
    edit_mode === 'insert'
      ? 'Insert new cell'
      : edit_mode === 'delete'
        ? 'Delete cell'
        : 'Replace cell contents'
  const cellTypeDescription = cell_type ? ` (${cell_type})` : ''
  const diffWidth = normalizeDiffWidth(width)
  const content =
    edit_mode === 'delete' ? (
      <Box flexDirection="column" paddingLeft={2}>
        <HighlightedCode code={oldSource} filePath={notebook_path} />
      </Box>
    ) : edit_mode === 'insert' ? (
      <Box flexDirection="column" paddingLeft={2}>
        <HighlightedCode
          code={new_source}
          filePath={cell_type === 'markdown' ? 'file.md' : notebook_path}
        />
      </Box>
    ) : hunks ? (
      intersperse(
        hunks.map(hunk => (
          <StructuredDiff
            key={hunk.newStart}
            patch={hunk}
            dim={false}
            width={diffWidth}
            filePath={notebook_path}
            firstLine={new_source.split('\n')[0] ?? null}
            fileContent={oldSource}
          />
        )),
        renderEllipsis,
      )
    ) : (
      <HighlightedCode
        code={new_source}
        filePath={cell_type === 'markdown' ? 'file.md' : notebook_path}
      />
    )

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Box paddingBottom={1} flexDirection="column">
          <Text bold={true}>{notebookPreviewLabel(notebook_path, verbose)}</Text>
          <Text dimColor={true}>
            {editTypeDescription} for cell {cell_id}
            {cellTypeDescription}
          </Text>
        </Box>
        {content}
      </Box>
    </Box>
  )
}

function renderEllipsis(i: number): ReactNode {
  return (
    <NoSelect fromLeftEdge={true} key={`ellipsis-${i}`}>
      <Text dimColor={true}>...</Text>
    </NoSelect>
  )
}

export const __notebookEditToolDiffTest = {
  loadNotebookPreview,
  normalizeDiffWidth,
}
