import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createBot } from './bot/createBot.js'
import { TaskManager } from './bot/taskManager.js'
import { LLMClient } from './llm/client.js'
import { SkillRegistry } from './skills/registry.js'
import { makeHelpers } from './skills/helpers.js'
import { builtinSkills } from './skills/builtin/index.js'
import { Agent } from './agent/agent.js'
import { PersistentMemory } from './agent/memory.js'
import { Autonomy } from './bot/autonomy.js'
import { SkillLibrary } from './skills/library/skillLibrary.js'
import { learningSkills } from './skills/library/learningSkills.js'

const cfg = loadConfig()
const log = createLogger(cfg.logging.level)
log.info({ config: cfg._file, llm: cfg.llm.baseUrl, mode: cfg.llm.mode, models: cfg.llm.models }, 'MineAgent starting')

const llm = new LLMClient(cfg.llm, log)
const memory = new PersistentMemory('./data/memory.json')

let reconnectDelay = 5000

function start () {
  const bot = createBot(cfg, log)
  const tasks = new TaskManager(bot, log)
  const registry = new SkillRegistry(log)

  const say = (text) => {
    const t = String(text).replace(/\s+/g, ' ').trim()
    if (!t) return
    const max = cfg.bot.chatMaxLength
    for (let i = 0; i < t.length && i < max * 4; i += max) bot.chat(t.slice(i, i + max))
    log.info({ say: t }, 'chat')
  }

  bot.once('spawn', async () => {
    const h = makeHelpers(bot, cfg, log)
    const ctx = { bot, cfg, log, h, tasks, memory, say, llm, registry }
    registry.registerAll(builtinSkills(ctx))

    const library = new SkillLibrary(ctx)
    try {
      await library.init()
      registry.registerAll(learningSkills(ctx, library))
      await library.registerLearned()
      log.info({ learned: library.count }, 'skill library ready')
    } catch (e) { log.error({ err: e.message }, 'skill library disabled') }

    const agent = new Agent({ ...ctx, helpers: h, embedder: library.embedder?.dim ? library.embedder : null })
    bot.on('chat', (username, message) => agent.handleChat(username, message))
    bot.on('whisper', (username, message) => agent.handleChat(username, message, { whisper: true }))

    const autonomy = new Autonomy({ ...ctx, agent, library })
    if (cfg.autonomy.enabled) autonomy.start()

    log.info({ skills: registry.list().map(s => s.name) }, 'ready')
    reconnectDelay = 5000
  })

  bot.on('end', (reason) => {
    log.warn({ reason }, `disconnected, reconnecting in ${reconnectDelay / 1000}s`)
    setTimeout(start, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })
}

start()
