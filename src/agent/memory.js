import fs from 'node:fs'
import path from 'node:path'

/** Tiny persistent key-value store (base location, chests, learned facts). */
export class PersistentMemory {
  constructor (file = './data/memory.json') {
    this.file = path.resolve(file)
    this.data = {}
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
  }

  get (k, dflt) { return this.data[k] ?? dflt }
  set (k, v) { this.data[k] = v; this.save() }
  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
