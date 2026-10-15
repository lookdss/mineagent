import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { LLMClient } from '../src/llm/client.js'

const cfg = loadConfig()
const log = createLogger('debug')
const llm = new LLMClient(cfg.llm, log)
console.log('Endpoint:', cfg.llm.baseUrl, 'mode:', cfg.llm.mode, 'models:', cfg.llm.models)
try { console.log('Available models:', await llm.listModels()) } catch (e) { console.log('models.list failed:', e.message) }
const r = await llm.chat({
  messages: [{ role: 'system', content: 'You are Bob, a Minecraft bot. Use tools.' }, { role: 'user', content: '[Steve]: Bob, come to me' }],
  tools: [{ type: 'function', function: { name: 'come_here', description: 'Walk to a player', parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] } } }]
})
console.log('Response:', JSON.stringify(r, null, 2))
if (cfg.embeddings.model) {
  try { const e = await llm.embed(cfg.embeddings.model, ['chop a tree']); console.log('Embedding dims:', e[0].length) } catch (e) { console.log('embeddings failed (will use local fallback):', e.message) }
}
