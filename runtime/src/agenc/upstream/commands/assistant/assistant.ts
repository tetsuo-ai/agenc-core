import { homedir } from 'node:os'; import { join } from 'node:path'; import { useEffect } from 'react'
export const computeDefaultInstallDir = async () => join(homedir(), '.agenc', 'assistant'); export function NewInstallWizard({ onCancel }: { onCancel: () => void }) { useEffect(() => onCancel(), [onCancel]); return null }
