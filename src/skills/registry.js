import { z } from 'zod'

/**
 * Registry of skills (builtin + learned). Each skill:
 *  { name, description, params: zodObject, long?: boolean, run(ctx, args, signal) }
 */
export class SkillRegistry {
  constructor (log) {
    this.log = log
    this.skills = new Map()
  }

  register (skill) {
    if (!skill.name || !skill.run) throw new Error('invalid skill')
    skill.params = skill.params ?? z.object({})
    this.skills.set(skill.name, skill)
    return skill
  }

  registerAll (list) { for (const s of list) this.register(s) }
  get (name) { return this.skills.get(name) }
  has (name) { return this.skills.has(name) }
  list () { return [...this.skills.values()] }

  /** OpenAI tools format */
  toTools (subset = null) {
    return (subset ?? this.list()).map(s => ({
      type: 'function',
      function: {
        name: s.name,
        description: s.description,
        parameters: cleanSchema(z.toJSONSchema(s.params))
      }
    }))
  }

  /** Validate (and gently coerce) arguments. Returns { ok, value, error } */
  validate (name, args) {
    const s = this.get(name)
    if (!s) return { ok: false, error: `unknown tool ${name}` }
    const res = s.params.safeParse(coerceLoose(args))
    if (res.success) return { ok: true, value: res.data }
    const issues = res.error.issues.map(i => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')
    return { ok: false, error: issues }
  }
}

function cleanSchema (schema) {
  const s = { ...schema }
  delete s.$schema
  if (!s.properties) s.properties = {}
  s.type = 'object'
  return s
}

/** Small-model tool calls are messy: numbers as strings, {} instead of missing, etc. */
function coerceLoose (args) {
  if (!args || typeof args !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    if (typeof v === 'string') {
      const t = v.trim()
      if (/^-?\d+(\.\d+)?$/.test(t)) { out[k] = Number(t); continue }
      if (t === 'true' || t === 'false') { out[k] = t === 'true'; continue }
    }
    out[k] = v
  }
  return out
}
