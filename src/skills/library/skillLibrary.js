import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import * as lancedb from '@lancedb/lancedb'
import { Embedder } from './embeddings.js'
import { Sandbox } from './sandbox.js'

/**
 * Voyager-style skill library: learned JS skills stored as files (source of truth) and indexed in LanceDB
 * by embedding of their description for semantic retrieval.
 */
export class SkillLibrary {
  constructor (ctx) {
    this.ctx = ctx
    const { cfg, log, llm } = ctx
    this.cfg = cfg.skillLibrary
    this.log = log
    this.dir = path.resolve(this.cfg.dir)
    this.codeDir = path.resolve(this.cfg.learnedCodeDir)
    this.embedder = new Embedder(llm, cfg.embeddings, log)
    this.sandbox = new Sandbox(ctx, this.cfg.sandboxTimeoutMs)
    this.table = null
    this.count = 0
  }

  async init () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.codeDir, { recursive: true })
    await this.embedder.init()
    this.db = await lancedb.connect(this.dir)
    const metaFile = path.join(this.dir, 'meta.json')
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {}
    const names = await this.db.tableNames()
    if (names.includes('skills') && meta.dim === this.embedder.dim && meta.mode === this.embedder.mode) {
      this.table = await this.db.openTable('skills')
    } else {
      if (names.includes('skills')) await this.db.dropTable('skills')
      this.table = null
      await this.reindex()
      fs.writeFileSync(metaFile, JSON.stringify({ dim: this.embedder.dim, mode: this.embedder.mode }))
    }
    this.count = (await this.table?.countRows()) ?? 0
  }

  listLearned () {
    return fs.readdirSync(this.codeDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(this.codeDir, f), 'utf8')))
  }

  async reindex () {
    const skills = this.listLearned()
    const rows = []
    for (const s of skills) rows.push(await this.toRow(s))
    if (!rows.length) {
      // create an empty table with the right schema using a dummy row then delete it
      const dummy = await this.toRow({ name: '__dummy', description: 'dummy', code: '', tags: [] })
      this.table = await this.db.createTable('skills', [dummy], { mode: 'overwrite' })
      await this.table.delete("name = '__dummy'")
    } else {
      this.table = await this.db.createTable('skills', rows, { mode: 'overwrite' })
    }
  }

  async toRow (s) {
    const [vector] = await this.embedder.embed([`${s.name}: ${s.description} ${(s.tags || []).join(' ')}`])
    return { name: s.name, description: s.description, code: s.code, tags: (s.tags || []).join(','), vector }
  }

  async add (skill) {
    const file = path.join(this.codeDir, `${skill.name}.json`)
    fs.writeFileSync(file, JSON.stringify(skill, null, 2))
    fs.writeFileSync(path.join(this.codeDir, `${skill.name}.js`), skill.code)
    await this.table.delete(`name = '${skill.name.replace(/'/g, "''")}'`)
    await this.table.add([await this.toRow(skill)])
    this.count = await this.table.countRows()
    this.registerOne(skill)
  }

  async search (query, k = 3) {
    if (!this.table || this.count === 0) return []
    const [vector] = await this.embedder.embed([query])
    const res = await this.table.vectorSearch(vector).distanceType('cosine').limit(k).toArray()
    return res.map(r => ({ name: r.name, description: r.description, code: r.code, tags: r.tags, similarity: 1 - r._distance }))
  }

  /** Register every learned skill as a tool in the registry. */
  async registerLearned () {
    for (const s of this.listLearned()) this.registerOne(s)
  }

  registerOne (s) {
    const { registry } = this.ctx
    registry.register({
      name: s.name,
      description: `[выученный навык] ${s.description}`,
      params: z.object({}).catchall(z.any()),
      long: true,
      learned: true,
      ack: () => `Выполняю выученный навык ${s.name}.`,
      run: async (args, signal) => {
        const { result } = await this.sandbox.run(s.code, s.name, args, signal)
        return result
      }
    })
  }
}
