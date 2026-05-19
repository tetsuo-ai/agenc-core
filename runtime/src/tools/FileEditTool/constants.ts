// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .agenc/ folder
export const AGENC_FOLDER_PERMISSION_PATTERN = '/.agenc/**'

// Permission pattern for granting session-level access to the global ~/.agenc/ folder
export const GLOBAL_AGENC_FOLDER_PERMISSION_PATTERN = '~/.agenc/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
