import crypto from 'node:crypto'

const LOCAL_DIM = 256

/** Deterministic hashed bag-of-words embedding used when no embedding model is available. */
export function localEmbed (text) {
  const v = new Float32Array(LOCAL_DIM)
  const tokens = String(text).toLowerCase().match(/[a-zа-яё0-9_]+/g) || []
  const grams = [...tokens]
  for (let i = 0; i < tokens.length - 1; i++) grams.push(tokens[i] + ' ' + tokens[i + 1])
  for (const t of grams) {
    const hsh = crypto.createHash('md5').update(t).digest()
    const idx = hsh.readUInt32LE(0) % LOCAL_DIM
    const sign = hsh[4] & 1 ? 1 : -1
    v[idx] += sign
  }
  let norm = Math.hypot(...v) || 1
  return Array.from(v, x => x / norm)
}

export class Embedder {
  constructor (llm, cfg, log) {
    this.llm = llm; this.cfg = cfg; this.log = log
    this.mode = cfg.model ? 'remote' : 'local'
    this.dim = null
  }

  async init () {
    if (this.mode === 'remote') {
      try {
        const [v] = await this.llm.embed(this.cfg.model, ['probe'])
        this.dim = v.length
        this.log.info({ model: this.cfg.model, dim: this.dim }, 'embeddings: remote model')
        return
      } catch (e) {
        if (!this.cfg.fallbackToLocal) throw e
        this.log.warn({ err: e.message }, 'embedding model unavailable, using local hashed embeddings')
        this.mode = 'local'
      }
    }
    this.dim = LOCAL_DIM
  }

  async embed (texts) {
    if (this.mode === 'remote') {
      try { return await this.llm.embed(this.cfg.model, texts) } catch (e) {
        if (!this.cfg.fallbackToLocal) throw e
        this.log.warn({ err: e.message }, 'embedding failed, switching to local')
        this.mode = 'local'; this.dim = LOCAL_DIM
        throw new Error('embedding dimension changed, reindex required')
      }
    }
    return texts.map(localEmbed)
  }
}
