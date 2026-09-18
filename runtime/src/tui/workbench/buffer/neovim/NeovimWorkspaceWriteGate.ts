import { BUFFER_MAX_FILE_BYTES } from "../fileSnapshot.js";
import {
  canonicalNeovimPath,
  canonicalNeovimPathIsAtOrWithin,
} from "./NeovimPath.js";
import type { RpcParams, RpcValue } from "./NeovimRpc.js";
import type { BufferWorkspaceWriteRequest } from "../providers/types.js";

/** Per-buffer ceiling applied before a workspace write manifest is admitted. */
export const WORKSPACE_WRITE_MAX_BUFFER_BYTES = BUFFER_MAX_FILE_BYTES;
/** Aggregate ceiling for every in-workspace buffer in one write-gate payload. */
export const WORKSPACE_WRITE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Maximum number of in-workspace file buffers a single write-gate payload may list. */
export const WORKSPACE_WRITE_MAX_BUFFER_COUNT = 512;

/**
 * Lua installed as the authoritative Neovim write gate.
 *
 * The second exec argument is the canonical workspace root. Out-of-workspace
 * buffers are excluded before their contents are read so they cannot trip the
 * RPC size limits or copy bytes AgenC does not claim.
 */
export const INSTALL_WORKSPACE_WRITE_GATE = String.raw`
local agenc_rpc_channel = select(1, ...)
local agenc_workspace_root = select(2, ...)
if type(agenc_rpc_channel) ~= 'number' or agenc_rpc_channel <= 0 then
  error('AgenC workspace write authority has no valid RPC channel')
end
if type(agenc_workspace_root) ~= 'string' or agenc_workspace_root == '' then
  error('AgenC workspace write authority has no valid workspace root')
end

local function agenc_fs()
  return vim.uv or vim.loop
end

local function agenc_is_windows()
  return vim.fn.has('win32') == 1
end

local function agenc_sep()
  if agenc_is_windows() then
    return '\\'
  end
  return '/'
end

local function agenc_is_absolute(path)
  if agenc_is_windows() then
    return path:match('^%a:[/\\]') ~= nil or path:match('^[\\/][\\/]') ~= nil
  end
  return path:sub(1, 1) == '/'
end

local function agenc_dirname(path)
  local parent = vim.fn.fnamemodify(path, ':h')
  if parent == path then
    return nil
  end
  return parent
end

local function agenc_join(root, parts)
  local sep = agenc_sep()
  local result = root
  for index = 1, #parts do
    if result:sub(-1) == sep then
      result = result .. parts[index]
    else
      result = result .. sep .. parts[index]
    end
  end
  return result
end

local function agenc_canonical_path(path)
  if type(path) ~= 'string' or path == '' then
    return nil
  end
  -- Do not use :p. That modifier lexically collapses symlink/.. and would
  -- treat an escaped path as if it were still inside the workspace.
  local absolute = path
  if not agenc_is_absolute(absolute) then
    absolute = agenc_join(vim.fn.getcwd(), { path })
  end
  local missing = {}
  local ancestor = absolute
  local fs = agenc_fs()
  while true do
    local real = fs.fs_realpath(ancestor)
    if type(real) == 'string' and real ~= '' then
      return agenc_join(real, missing)
    end
    local parent = agenc_dirname(ancestor)
    if parent == nil then
      return nil
    end
    table.insert(missing, 1, vim.fn.fnamemodify(ancestor, ':t'))
    ancestor = parent
  end
end

local function agenc_path_key(path)
  if agenc_is_windows() then
    return string.lower(path)
  end
  return path
end

local function agenc_path_is_at_or_within(candidate, parent)
  local canon_parent = agenc_canonical_path(parent)
  local canon_candidate = agenc_canonical_path(candidate)
  if type(canon_parent) ~= 'string' or type(canon_candidate) ~= 'string' then
    return false
  end
  local parent_key = agenc_path_key(canon_parent)
  local candidate_key = agenc_path_key(canon_candidate)
  if candidate_key == parent_key then
    return true
  end
  local sep = agenc_sep()
  local prefix = parent_key
  if prefix:sub(-1) ~= sep then
    prefix = prefix .. sep
  end
  return candidate_key:sub(1, #prefix) == prefix
end

local function agenc_capture_workspace_write(event)
  local target = event.buf
  local buffers = {}
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buffer) then
      local name = vim.api.nvim_buf_get_name(buffer)
      local buffer_type =
        vim.api.nvim_get_option_value('buftype', { buf = buffer })
      if name ~= ''
          and buffer_type == ''
          and agenc_path_is_at_or_within(name, agenc_workspace_root) then
        local end_of_line =
          vim.api.nvim_get_option_value('eol', { buf = buffer })
        local content = table.concat(
          vim.api.nvim_buf_get_lines(buffer, 0, -1, true),
          '\n'
        )
        if end_of_line then content = content .. '\n' end
        table.insert(buffers, {
          path = name,
          buffer_handle = buffer,
          changedtick = vim.api.nvim_buf_get_changedtick(buffer),
          end_of_line = end_of_line,
          dirty = vim.api.nvim_get_option_value('modified', { buf = buffer }),
          content = content,
        })
      end
    end
  end
  return {
    target = {
      path = event.file,
      source_path = vim.api.nvim_buf_get_name(target),
      kind = event.event == 'BufWritePre'
          and 'buffer'
        or event.event == 'FileAppendPre'
          and 'append'
        or 'file',
      buffer_handle = target,
      changedtick = vim.api.nvim_buf_get_changedtick(target),
      end_of_line =
        vim.api.nvim_get_option_value('eol', { buf = target }),
      line_start = vim.fn.line("'["),
      line_end = vim.fn.line("']"),
    },
    buffers = buffers,
  }
end

vim.api.nvim_create_autocmd(
  { 'BufWritePre', 'FileWritePre', 'FileAppendPre' },
{
  group = vim.api.nvim_create_augroup(
    'AgenCWorkspaceWriteAuthority',
    { clear = true }
  ),
  callback = function(event)
    local request = agenc_capture_workspace_write(event)
    local ok, response = pcall(
      vim.rpcrequest,
      agenc_rpc_channel,
      'agenc_before_workspace_write',
      request
    )
    if not ok then
      error(
        'AgenC blocked :write because workspace authority could not be verified: '
          .. string.sub(tostring(response), 1, 512)
      )
    end
    if type(response) ~= 'table' or response.allowed ~= true then
      local reason = type(response) == 'table'
          and type(response.reason) == 'string'
          and response.reason
        or 'the daemon did not acknowledge this exact buffer revision'
      error('AgenC blocked :write: ' .. string.sub(reason, 1, 512))
    end
  end,
})
return true
`;

/**
 * Decide whether a loaded Neovim buffer belongs in the workspace write-gate
 * payload. Fail closed when the path cannot be resolved.
 */
export function neovimWorkspaceWriteBufferIsInScope(
  bufferPath: string,
  workspaceRoot: string,
): boolean {
  if (bufferPath.length === 0 || workspaceRoot.trim().length === 0) {
    return false;
  }
  try {
    return canonicalNeovimPathIsAtOrWithin(
      canonicalNeovimPath(bufferPath, workspaceRoot),
      workspaceRoot,
    );
  } catch {
    return false;
  }
}

export function workspaceWriteRequestFromRpcParams(
  params: RpcParams,
  workspaceRoot?: string,
): BufferWorkspaceWriteRequest | null {
  if (params.length !== 1) return null;
  const request = rpcRecord(params[0]);
  const target = rpcRecord(request?.target);
  const rawBuffers = request?.buffers;
  const targetPath = typeof target?.path === "string" ? target.path : "";
  const sourcePath =
    typeof target?.source_path === "string" ? target.source_path : "";
  const targetKind = target?.kind;
  const targetBufferHandle = positiveInteger(target?.buffer_handle);
  const targetChangedtick = nonNegativeInteger(target?.changedtick);
  const lineStart = positiveInteger(target?.line_start);
  const lineEnd = positiveInteger(target?.line_end);
  if (
    targetPath.length === 0 ||
    targetPath.length > 32_768 ||
    sourcePath.length === 0 ||
    sourcePath.length > 32_768 ||
    (targetKind !== "buffer" &&
      targetKind !== "file" &&
      targetKind !== "append") ||
    targetBufferHandle === null ||
    targetChangedtick === null ||
    lineStart === null ||
    lineEnd === null ||
    lineEnd < lineStart ||
    typeof target?.end_of_line !== "boolean" ||
    !Array.isArray(rawBuffers)
  ) {
    return null;
  }
  const scopedRoot =
    typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0
      ? workspaceRoot
      : undefined;
  const buffers: BufferWorkspaceWriteRequest["buffers"][number][] = [];
  let totalBytes = 0;
  for (const rawBuffer of rawBuffers) {
    const buffer = rpcRecord(rawBuffer);
    const path = typeof buffer?.path === "string" ? buffer.path : "";
    if (path.length > 32_768) return null;
    if (
      path.length > 0 &&
      scopedRoot !== undefined &&
      !neovimWorkspaceWriteBufferIsInScope(path, scopedRoot)
    ) {
      continue;
    }
    const bufferHandle = positiveInteger(buffer?.buffer_handle);
    const changedtick = nonNegativeInteger(buffer?.changedtick);
    const content = typeof buffer?.content === "string" ? buffer.content : null;
    if (
      path.length === 0 ||
      bufferHandle === null ||
      changedtick === null ||
      typeof buffer?.end_of_line !== "boolean" ||
      typeof buffer?.dirty !== "boolean" ||
      content === null
    ) {
      return null;
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > WORKSPACE_WRITE_MAX_BUFFER_BYTES) return null;
    totalBytes += contentBytes;
    if (totalBytes > WORKSPACE_WRITE_MAX_TOTAL_BYTES) return null;
    buffers.push({
      path,
      bufferHandle,
      changedtick,
      endOfLine: buffer.end_of_line,
      dirty: buffer.dirty,
      content,
    });
  }
  if (buffers.length > WORKSPACE_WRITE_MAX_BUFFER_COUNT) return null;
  return {
    target: {
      path: targetPath,
      sourcePath,
      kind: targetKind,
      bufferHandle: targetBufferHandle,
      changedtick: targetChangedtick,
      endOfLine: target.end_of_line,
      lineStart,
      lineEnd,
    },
    buffers,
  };
}

function rpcRecord(
  value: RpcValue | undefined,
): { readonly [key: string]: RpcValue } | null {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return null;
  }
  return value as { readonly [key: string]: RpcValue };
}

function positiveInteger(value: RpcValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: RpcValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
