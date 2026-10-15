import OpenAI from 'openai'

/**
 * Thin wrapper over an OpenAI-compatible endpoint (LM Studio by default).
 * Handles single/dual model routing, tool-call parsing fallbacks and retries.
 */
export class LLMClient {
  constructor (cfg, log) {
    this.cfg = cfg
    this.log = log
    this.client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.requestTimeoutMs, maxRetries: 1 })
  }

  modelFor (role) {
    if (role === 'coder' && this.cfg.mode === 'dual' && this.cfg.models.coder) return this.cfg.models.coder
    return this.cfg.models.chat
  }

  async chat ({ role = 'chat', messages, tools, toolChoice = 'auto', temperature, maxTokens, jsonMode = false }) {
    const model = this.modelFor(role)
    const body = {
      model,
      messages,
      temperature: temperature ?? this.cfg.temperature,
      max_tokens: maxTokens ?? this.cfg.maxTokens
    }
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice }
    if (jsonMode) body.response_format = { type: 'json_object' }
    const t0 = Date.now()
    const res = await this.client.chat.completions.create(body)
    const msg = res.choices?.[0]?.message ?? { role: 'assistant', content: '' }
    this.log.debug({ model, ms: Date.now() - t0, usage: res.usage }, 'llm response')
    return normalizeMessage(msg, tools)
  }

  async embed (model, input) {
    const res = await this.client.embeddings.create({ model, input })
    return res.data.map(d => d.embedding)
  }

  async listModels () {
    const res = await this.client.models.list()
    return res.data.map(m => m.id)
  }
}

/** Some local models emit tool calls as text (<tool_call>{...}</tool_call> or bare JSON). Recover them. */
export function normalizeMessage (msg, tools) {
  const out = { role: 'assistant', content: msg.content ?? '', tool_calls: [] }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    out.tool_calls = msg.tool_calls.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name,
      arguments: safeParseArgs(tc.function?.arguments)
    }))
    return out
  }
  if (!tools?.length || !out.content) return out
  const names = new Set(tools.map(t => t.function.name))
  const text = out.content
  const candidates = []
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) candidates.push(m[1])
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1])
  const bare = text.trim()
  if (bare.startsWith('{') && bare.endsWith('}')) candidates.push(bare)
  let rest = text
  for (const c of candidates) {
    try {
      const j = JSON.parse(c)
      const name = j.name || j.function || j.tool
      const args = j.arguments ?? j.parameters ?? j.args ?? {}
      if (name && names.has(name)) {
        out.tool_calls.push({ id: `call_${out.tool_calls.length}`, name, arguments: typeof args === 'string' ? safeParseArgs(args) : args })
        rest = rest.replace(c, '')
      }
    } catch { /* not json */ }
  }
  if (out.tool_calls.length) out.content = rest.replace(/<\/?tool_call>/g, '').replace(/```(json)?/g, '').trim()
  return out
}

function safeParseArgs (s) {
  if (s == null) return {}
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch {}
  try { return JSON.parse(s.replace(/'/g, '"')) } catch {}
  return {}
}
