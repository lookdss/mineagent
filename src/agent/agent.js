import { systemPrompt } from '../llm/prompts.js'
import { snapshot } from '../bot/sensors.js'
import { TaskCancelled } from '../bot/taskManager.js'
import { ToolSelector } from './toolSelector.js'

/**
 * Fast loop: chat → LLM (tools) → skills. One conversation processed at a time.
 */
export class Agent {
  constructor ({ bot, cfg, log, llm, registry, tasks, helpers, memory, say, embedder = null }) {
    Object.assign(this, { bot, cfg, log, llm, registry, tasks, helpers, memory, say })
    this.selector = new ToolSelector(registry, embedder, log)
    this.history = []
    this.queue = Promise.resolve()
    this.triggerRe = new RegExp(`(^|[\\s,.!?])(${cfg.bot.triggerNames.map(escapeRe).join('|')})([\\s,.!?:]|$)`, 'i')
  }

  isAddressed (text, whisper = false) {
    return whisper || this.triggerRe.test(text)
  }

  stripName (text) {
    return text.replace(this.triggerRe, '$1$3').replace(/^[\s,.:]+/, '').replace(/^[!?]+\s+/, '').trim() || text
  }

  /** Entry point for chat/whisper. Returns a promise that resolves when handled. */
  handleChat (username, text, { whisper = false } = {}) {
    if (username === this.bot.username) return
    if (!this.isAddressed(text, whisper)) return
    const msg = this.stripName(text)
    this.log.info({ from: username, msg }, 'command')
    if (msg.startsWith('!')) {
      this.queue = this.queue.then(() => this.direct(username, msg.slice(1)).catch(e => this.say(`Ошибка: ${e.message}`)))
      return this.queue
    }
    this.queue = this.queue.then(() => this.process(username, msg).catch(e => this.log.error({ err: e.message, stack: e.stack }, 'agent failed')))
    return this.queue
  }

  /** `!tool_name {"json":"args"}` or `!tool_name key=value ...` — runs a skill directly, bypassing the LLM. */
  async direct (username, text) {
    const m = text.trim().match(/^(\S+)\s*([\s\S]*)$/)
    const name = m?.[1] ?? ''; const raw = (m?.[2] ?? '').trim()
    if (name === 'help' || name === 'tools') { this.say(this.registry.list().map(s => s.name).join(', ')); return }
    let args = {}
    if (raw.startsWith('{')) args = JSON.parse(raw)
    else {
      // key=value key2="value with spaces" key3='...'
      const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g
      let kv
      while ((kv = re.exec(raw))) args[kv[1]] = kv[2] ?? kv[3] ?? kv[4]
    }
    const r = await this.executeTool({ id: 'direct', name, arguments: args }, username)
    if (!r.spoke) this.say(r.text)
  }

  buildMessages (username, msg) {
    const snap = snapshot(this.bot, this.tasks, { baseChests: this.memory.get('baseChests', []) })
    const messages = [
      { role: 'system', content: systemPrompt(this.cfg) },
      { role: 'system', content: `Текущее состояние (JSON):\n${JSON.stringify(snap)}` },
      ...this.history.slice(-this.cfg.llm.historyTurns * 2),
      { role: 'user', content: `[${username}]: ${msg}` }
    ]
    if (this.cfg.bot.language === 'ru') messages.push({ role: 'system', content: 'Напоминание: если это просьба что-то сделать — вызови инструмент. Текстом отвечай только по-русски и кратко.' })
    return messages
  }

  async process (username, msg) {
    const messages = this.buildMessages(username, msg)
    const selected = await this.selector.select(msg, this.cfg.llm.maxToolsPerRequest)
    const tools = this.registry.toTools(selected)
    let finalText = null
    let spoke = false
    for (let round = 0; round < this.cfg.llm.maxToolRounds; round++) {
      let res
      try {
        res = await this.llm.chat({ messages, tools })
      } catch (e) {
        this.log.error({ err: e.message }, 'llm error')
        this.say('Не могу связаться с моделью (LLM недоступна).')
        return
      }
      if (!res.tool_calls.length && round === 0 && this.cfg.llm.routerFallback && looksLikeCommand(msg)) {
        const routed = await this.routerFallback(username, msg, selected)
        if (routed) { this.log.info({ routed }, 'router fallback picked a tool'); res = { content: '', tool_calls: [routed] } }
      }
      if (!res.tool_calls.length) { finalText = res.content; break }

      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }))
      })
      let startedLong = false
      for (const tc of res.tool_calls) {
        const result = await this.executeTool(tc, username)
        if (result.spoke) spoke = true
        if (result.startedLong) startedLong = true
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text })
      }
      if (startedLong || spoke) break
    }
    if (finalText) {
      this.say(finalText)
      this.history.push({ role: 'user', content: `[${username}]: ${msg}` }, { role: 'assistant', content: finalText })
    } else {
      const toolMsgs = messages.filter(m => m.role === 'tool').map(m => m.content).join(' | ')
      this.history.push({ role: 'user', content: `[${username}]: ${msg}` }, { role: 'assistant', content: toolMsgs.slice(0, 300) || '(выполнено)' })
    }
    if (this.history.length > this.cfg.llm.historyTurns * 2) this.history.splice(0, this.history.length - this.cfg.llm.historyTurns * 2)
  }

  /**
   * Second chance for models that answer in prose instead of calling a tool:
   * ask for a strict JSON routing decision.
   */
  async routerFallback (username, msg, selected) {
    const list = selected.map(s => `- ${s.name}: ${s.description} | params: ${Object.keys(s.params.shape || {}).join(', ') || '-'}`).join('\n')
    try {
      const r = await this.llm.chat({
        jsonMode: true, temperature: 0, maxTokens: 200,
        messages: [
          { role: 'system', content: `You route Minecraft chat commands to bot tools. Tools:\n${list}\nReply with JSON only: {"tool": "<name or null>", "args": {...}}. Use null if the message is just conversation. Item/block names must be Minecraft English ids. Default player is the author.` },
          { role: 'user', content: `[${username}]: ${msg}` }
        ]
      })
      const j = JSON.parse(r.content.match(/\{[\s\S]*\}/)?.[0] || '{}')
      if (!j.tool || j.tool === 'null' || !this.registry.has(j.tool)) return null
      return { id: 'router_0', name: j.tool, arguments: j.args && typeof j.args === 'object' ? j.args : {} }
    } catch (e) { this.log.debug({ err: e.message }, 'router fallback failed'); return null }
  }

  /** Validate args, run quick skills inline, run long skills through TaskManager (with quick-return). */
  async executeTool (tc, requester) {
    const skill = this.registry.get(tc.name)
    if (!skill) return { text: `Ошибка: инструмента ${tc.name} нет. Доступные: ${this.registry.list().map(s => s.name).join(', ')}` }
    if (tc.arguments && typeof tc.arguments === 'object' && 'player' in skill.params.shape && !tc.arguments.player) tc.arguments.player = requester
    if ('player' in skill.params.shape && tc.arguments.player && !this.bot.players[tc.arguments.player]) {
      const names = Object.keys(this.bot.players).filter(n => n !== this.bot.username)
      const found = names.find(n => n.toLowerCase() === String(tc.arguments.player).toLowerCase())
      tc.arguments.player = found || (names.length === 1 ? names[0] : requester)
    }
    const v = this.registry.validate(tc.name, tc.arguments)
    if (!v.ok) return { text: `Ошибка параметров для ${tc.name}: ${v.error}. Исправь вызов.` }
    const args = v.value
    this.log.info({ tool: tc.name, args }, 'tool call')

    if (!skill.long) {
      try {
        const r = await skill.run(args, new AbortController().signal)
        return { text: String(r), spoke: tc.name === 'say' }
      } catch (e) { return { text: `Ошибка ${tc.name}: ${e.message}` } }
    }

    const ack = skill.ack ? skill.ack(args) : `Выполняю ${tc.name}.`
    const taskPromise = this.tasks.run(tc.name, (signal) => skill.run(args, signal), { requester, cancelCurrent: this.cfg.bot.cancelTaskOnNewCommand })
    const quick = await Promise.race([
      taskPromise.then(r => ({ done: true, result: String(r) }), e => ({ done: true, error: e })),
      new Promise(r => setTimeout(() => r({ done: false }), this.cfg.bot.quickTaskTimeoutMs))
    ])
    if (quick.done) {
      if (quick.error) {
        if (quick.error instanceof TaskCancelled) return { text: 'Задача отменена.', spoke: false }
        this.say(`Не получилось: ${quick.error.message}`)
        return { text: `Ошибка ${tc.name}: ${quick.error.message}`, spoke: true }
      }
      this.say(quick.result)
      return { text: quick.result, spoke: true }
    }
    this.say(ack)
    taskPromise.then(r => this.say(String(r)), e => {
      if (e instanceof TaskCancelled) return
      this.say(`Не получилось (${tc.name}): ${e.message}`)
    })
    return { text: `${tc.name} запущена в фоне: ${ack}`, startedLong: true, spoke: true }
  }
}

const COMMAND_RE = /(подойд|иди|пойд|след|добудь|добыть|собер|наруб|сруб|скрафт|сдела|постро|построй|дай|отдай|принес|сложи|положи|возьми|атак|убей|охот|посади|посей|собери|урожай|стоп|останов|запомни|база|верни|вернись|покажи|статус|инвентар|научись|выучи|come|follow|go |goto|collect|mine|chop|craft|build|give|deposit|attack|kill|hunt|farm|harvest|stop|learn|inventory|status)/i
function looksLikeCommand (msg) { return COMMAND_RE.test(msg) }

function escapeRe (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
