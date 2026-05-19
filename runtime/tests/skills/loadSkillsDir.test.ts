import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { getSkillDirCommands, clearSkillCaches } from './loadSkillsDir.js'

function writeSkill(rootDir: string, skillPath: string): void {
  const skillDir = join(rootDir, '.agenc', 'skills', ...skillPath.split('/'))
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\ndescription: ${skillPath}\n---\n# ${skillPath}\n`,
    'utf8',
  )
}

test('loads flat and nested skills with colon namespaces', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'agenc-skills-'))
  const cwd = join(configDir, 'workspace')
  const originalConfigDir = process.env.AGENC_CONFIG_DIR

  try {
    mkdirSync(cwd, { recursive: true })
    writeSkill(configDir, 'flat-skill')
    writeSkill(configDir, 'git/commit')
    writeSkill(configDir, 'frontend/react/form')

    process.env.AGENC_CONFIG_DIR = configDir
    clearSkillCaches()

    const skills = await getSkillDirCommands(cwd)
    const promptSkills = skills.filter(skill => skill.type === 'prompt')
    const skillNames = promptSkills.map(skill => skill.name).sort()

    assert.deepEqual(skillNames, [
      'flat-skill',
      'frontend:react:form',
      'git:commit',
    ])

    const nestedSkill = promptSkills.find(skill => skill.name === 'git:commit')
    assert.ok(nestedSkill)
    assert.equal(nestedSkill.skillRoot, join(configDir, '.agenc', 'skills', 'git', 'commit'))

    const deepSkill = promptSkills.find(
      skill => skill.name === 'frontend:react:form',
    )
    assert.ok(deepSkill)
    assert.equal(
      deepSkill.skillRoot,
      join(configDir, '.agenc', 'skills', 'frontend', 'react', 'form'),
    )
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.AGENC_CONFIG_DIR
    } else {
      process.env.AGENC_CONFIG_DIR = originalConfigDir
    }
    clearSkillCaches()
    rmSync(configDir, { recursive: true, force: true })
  }
})
