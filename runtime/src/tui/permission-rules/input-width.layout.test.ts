import { describe, expect, it } from 'vitest'

import { getAddWorkspaceDirectoryInputColumns } from './AddWorkspaceDirectory.js'
import { getPermissionRuleInputColumns } from './PermissionRuleInput.js'

describe('permission rules input width helpers', () => {
  it('clamps permission rule input columns to a positive terminal-relative width', () => {
    expect(getPermissionRuleInputColumns(Number.NaN)).toBe(1)
    expect(getPermissionRuleInputColumns(0)).toBe(1)
    expect(getPermissionRuleInputColumns(6)).toBe(1)
    expect(getPermissionRuleInputColumns(20)).toBe(14)
  })

  it('clamps workspace directory input columns to a positive dialog-relative width', () => {
    expect(getAddWorkspaceDirectoryInputColumns(Number.NaN)).toBe(1)
    expect(getAddWorkspaceDirectoryInputColumns(0)).toBe(1)
    expect(getAddWorkspaceDirectoryInputColumns(10)).toBe(1)
    expect(getAddWorkspaceDirectoryInputColumns(40.9)).toBe(30)
  })
})
