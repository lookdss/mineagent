/**
 * Picks the most relevant subset of tools for a message (small local models get confused by 25+ tools).
 * Uses the skill library embedder when available, otherwise keyword overlap.
 */
export class ToolSelector {
  constructor (registry, embedder, log) {
    this.registry = registry
    this.embedder = embedder
    this.log = log
    this.cache = new Map() // name -> vector
    this.always = new Set(['say', 'stop', 'learn_skill', 'get_status'])
  }

  async ensureVectors () {
    if (!this.embedder) return false
    const missing = this.registry.list().filter(s => !this.cache.has(s.name))
    if (!missing.length) return true
    try {
      const vecs = await this.embedder.embed(missing.map(s => `${s.name.replace(/_/g, ' ')}: ${s.description}`))
      missing.forEach((s, i) => this.cache.set(s.name, vecs[i]))
      return true
    } catch (e) { this.log.debug({ err: e.message }, 'tool embedding failed'); return false }
  }

  async select (message, max) {
    const all = this.registry.list()
    if (!max || max <= 0 || all.length <= max) return all
    let scored
    if (await this.ensureVectors()) {
      const [q] = await this.embedder.embed([message])
      scored = all.map(s => ({ s, score: cosine(q, this.cache.get(s.name) || []) }))
    } else {
      const words = new Set(message.toLowerCase().match(/[a-zа-яё_]{3,}/g) || [])
      scored = all.map(s => ({ s, score: [...words].filter(w => (s.name + ' ' + s.description).toLowerCase().includes(w)).length }))
    }
    scored.sort((a, b) => b.score - a.score)
    const chosen = []
    for (const { s } of scored) { if (this.always.has(s.name)) continue; if (chosen.length >= max - this.always.size) break; chosen.push(s) }
    for (const n of this.always) { const s = this.registry.get(n); if (s) chosen.push(s) }
    return chosen
  }
}

function cosine (a, b) {
  if (!a?.length || a.length !== b.length) return 0
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
