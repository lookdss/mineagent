import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { parentChannel } from './ipc.js'
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
import { snapshot } from './bot/sensors.js'

const cfg = loadConfig()
const log = createLogger(cfg.logging.level)
const gui = parentChannel()
const emit = (msg) => gui?.send(msg)
log.info({ config: cfg._file, llm: cfg.llm.baseUrl, mode: cfg.llm.mode, models: cfg.llm.models, gui: !!gui }, 'MineAgent starting')

const llm = new LLMClient(cfg.llm, log)
const memory = new PersistentMemory('./data/memory.json')

let reconnectDelay = 5000
let current = null // { bot, agent, tasks }
let shuttingDown = false

function start () {
  emit({ type: 'state', state: 'connecting', host: cfg.minecraft.host, port: cfg.minecraft.port })
  const bot = createBot(cfg, log)
  const tasks = new TaskManager(bot, log)
  const registry = new SkillRegistry(log)
  current = { bot, tasks, agent: null }

  const say = (text) => {
    const t = String(text).replace(/\s+/g, ' ').trim()
    if (!t) return
    const max = cfg.bot.chatMaxLength
    for (let i = 0; i < t.length && i < max * 4; i += max) bot.chat(t.slice(i, i + max))
    log.info({ say: t }, 'chat')
    emit({ type: 'chat', from: bot.username, text: t, self: true })
  }

  bot.once('spawn', async () => {
    emit({ type: 'state', state: 'spawned', username: bot.username, version: bot.version })
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
    current.agent = agent
    bot.on('chat', (username, message) => {
      if (username !== bot.username) emit({ type: 'chat', from: username, text: message })
      agent.handleChat(username, message)
    })
    bot.on('whisper', (username, message) => {
      emit({ type: 'chat', from: username, text: message, whisper: true })
      agent.handleChat(username, message, { whisper: true })
    })

    const autonomy = new Autonomy({ ...ctx, agent, library })
    if (cfg.autonomy.enabled) autonomy.start()

    log.info({ skills: registry.list().map(s => s.name) }, 'ready')
    emit({ type: 'ready', skills: registry.list().map(s => s.name) })
    reconnectDelay = 5000

    if (gui) {
      const timer = setInterval(() => {
        if (!bot.entity) return
        try { emit({ type: 'status', ...snapshot(bot, tasks, { baseChests: memory.get('baseChests', []) }) }) } catch {}
      }, 2000)
      bot.once('end', () => clearInterval(timer))
    }
  })

  bot.on('kicked', (reason) => log.warn({ reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }, 'kicked'))
  bot.on('error', (err) => log.error({ err: err.message }, 'bot error'))
  bot.on('end', (reason) => {
    current = null
    emit({ type: 'state', state: 'disconnected', reason })
    if (shuttingDown) return
    log.warn({ reason }, `disconnected, reconnecting in ${reconnectDelay / 1000}s`)
    setTimeout(start, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })
}

gui?.on((msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'chat') {
    // Text typed in the GUI is treated as a whisper from the operator: no trigger name needed.
    const from = String(msg.from || cfg.bot.ownerPlayers[0] || 'Operator')
    if (!current?.agent) { emit({ type: 'chat', from: 'MineAgent', text: 'Бот ещё не в игре.', system: true }); return }
    if (msg.inGame) current.bot.chat(String(msg.text))
    else current.agent.handleChat(from, String(msg.text), { whisper: true })
  } else if (msg.type === 'shutdown') {
    shuttingDown = true
    log.info('shutdown requested')
    try { current?.tasks.cancel('shutdown') } catch {}
    try { current?.bot.quit() } catch {}
    setTimeout(() => process.exit(0), 500)
  }
})

process.on('SIGTERM', () => { shuttingDown = true; try { current?.bot.quit() } catch {}; setTimeout(() => process.exit(0), 300) })
process.on('uncaughtException', (e) => log.error({ err: e.message, stack: e.stack }, 'uncaught exception'))
process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'unhandled rejection'))

start()
