import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { 
  addGlobalEntity, 
  addGlobalRelation, 
  addGlobalSummary, 
  searchGlobalGraph, 
  loadProjectGraph,
  getProjectGraphPath,
  resetGlobalGraph,
  saveProjectGraph
} from '../../src/utils/knowledgeGraph.ts'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getFsImplementation } from '../../src/utils/fsOperations.ts'

describe('KnowledgeGraph Global Persistence & RAG', () => {
  const cwd = getFsImplementation().cwd()
  const originalConfigDir = process.env.AGENC_CONFIG_DIR
  let tempConfigDir: string

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'agenc-knowledge-graph-'))
    process.env.AGENC_CONFIG_DIR = tempConfigDir
    resetGlobalGraph()
    rmSync(getProjectGraphPath(cwd), { force: true })
  })

  afterEach(() => {
    resetGlobalGraph()
    rmSync(tempConfigDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) {
      delete process.env.AGENC_CONFIG_DIR
    } else {
      process.env.AGENC_CONFIG_DIR = originalConfigDir
    }
  })

  it('persists entities across loads', async () => {
    addGlobalEntity('server', 'prod-1', { ip: '1.2.3.4' })
    saveProjectGraph(cwd)
    
    const { loadProjectGraph: loadFreshProjectGraph } = await import(
      `../../src/utils/knowledgeGraph.ts?fresh=${Date.now()}-${Math.random()}`
    )
    const graph = loadFreshProjectGraph(cwd)
    const entity = Object.values(graph.entities).find(e => e.name === 'prod-1')
    expect(entity).toBeDefined()
    expect(entity?.attributes.ip).toBe('1.2.3.4')
  })

  it('performs keyword-based RAG search', () => {
    addGlobalSummary('The database uses PostgreSQL version 15.', ['database', 'postgres', 'sql'])
    addGlobalSummary('The frontend is built with React and Tailwind.', ['frontend', 'react', 'css'])

    const result = searchGlobalGraph('Tell me about the database setup')
    expect(result).toContain('PostgreSQL')
    
    const result2 = searchGlobalGraph('What react components are used?')
    expect(result2).toContain('React')
  })

  it('deduplicates entities and updates attributes', () => {
    addGlobalEntity('tool', 'agenc', { status: 'alpha' })
    addGlobalEntity('tool', 'agenc', { status: 'beta', version: '0.6.0' })
    
    const graph = loadProjectGraph(cwd)
    const entities = Object.values(graph.entities).filter(e => e.name === 'agenc')
    expect(entities.length).toBe(1)
    expect(entities[0].attributes.status).toBe('beta')
    expect(entities[0].attributes.version).toBe('0.6.0')
  })
})
