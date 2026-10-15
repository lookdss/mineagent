import { z } from 'zod'
import { coderSystemPrompt } from '../../llm/prompts.js'
import { snapshot } from '../../bot/sensors.js'
import { SandboxError, extractFunctionName, staticCheck } from './sandbox.js'

/**
 * Slow loop: synthesize a new skill with the coder model, test it in the sandbox,
 * iterate on errors (max N), then persist to the library.
 */
export class SkillSynthesizer {
  constructor (ctx, library) {
    this.ctx = ctx
    this.library = library
    this.queue = Promise.resolve()
  }

  enqueue (fn) {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => {})
    return p
  }

  async synthesize ({ task, skillName, args = {}, signal, onProgress = () => {} }) {
    const { llm, cfg, log, bot, tasks, registry } = this.ctx
    const name = sanitizeName(skillName || await this.proposeName(task))
    const existing = registry.list().filter(s => !s.learned).map(s => `${s.name}(${Object.keys(s.params.shape || {}).join(', ')})`).join(', ')
    const snap = snapshot(bot, tasks)
    const messages = [
      { role: 'system', content: coderSystemPrompt() },
      { role: 'user', content: `Task: ${task}\nFunction name: ${name}\nargs passed at runtime: ${JSON.stringify(args)}\nCurrent bot state: ${JSON.stringify(snap)}\nBuiltin skills already exist (do not reimplement them, your function should do the NEW thing): ${existing}\nWrite the function now.` }
    ]
    let code = null; let lastError = null
    for (let attempt = 1; attempt <= cfg.skillLibrary.maxFixIterations; attempt++) {
      if (signal?.aborted) throw new Error('cancelled')
      onProgress(attempt === 1 ? 'Пишу код навыка…' : `Исправляю ошибку (попытка ${attempt})…`)
      const res = await llm.chat({ role: 'coder', messages, temperature: 0.2, maxTokens: 2048 })
      code = extractCode(res.content)
      if (!code) { lastError = 'No ```js code block found'; messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: 'Reply with the function in a single ```js code block only.' }); continue }
      const fnName = extractFunctionName(code)
      if (fnName && fnName !== name) code = code.replace(new RegExp(`async\\s+function\\s+${fnName}\\s*\\(`), `async function ${name}(`)
      const staticErr = staticCheck(code)
      if (staticErr) { lastError = staticErr; messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `Rejected: ${staticErr}. Rewrite without it.` }); continue }
      log.info({ name, attempt }, 'testing generated skill')
      try {
        const { result, logs } = await this.library.sandbox.run(code, name, args, signal)
        log.info({ name, result }, 'generated skill succeeded')
        return { name, code, result, logs, attempts: attempt }
      } catch (e) {
        if (signal?.aborted) throw e
        lastError = e instanceof SandboxError ? `${e.message}${e.line ? ` (line ${e.line})` : ''}` : e.message
        log.warn({ name, attempt, err: lastError }, 'generated skill failed')
        messages.push({ role: 'assistant', content: res.content }, {
          role: 'user',
          content: `Execution failed: ${lastError}\nLogs: ${(e.logs || []).slice(-5).join(' | ') || 'none'}\nBot state now: ${JSON.stringify(snapshot(bot, tasks).self)}\nFix the function and return the full corrected code in a single \`\`\`js block.`
        })
      }
    }
    throw new Error(`не смог написать рабочий навык за ${cfg.skillLibrary.maxFixIterations} попыток. Последняя ошибка: ${lastError}`)
  }

  async proposeName (task) {
    const { llm } = this.ctx
    try {
      const r = await llm.chat({
        role: 'coder',
        messages: [
          { role: 'system', content: 'You name JavaScript functions. Reply with ONLY a short snake_case English identifier (2-4 words, ASCII letters and underscores) describing the task. Example: task "выкопать яму 3x3" -> dig_small_pit' },
          { role: 'user', content: task }
        ],
        maxTokens: 16,
        temperature: 0
      })
      const n = sanitizeName(r.content)
      if (/^[a-z][a-z0-9_]{2,40}$/.test(n) && n.includes('_')) return n
    } catch {}
    return `skill_${Date.now().toString(36)}`
  }

  /** Embedding models handle English far better than Russian, so index/search skills by an English description. */
  async toEnglish (task) {
    if (!/[\u0400-\u04FF]/.test(task)) return task
    const { llm } = this.ctx
    try {
      const r = await llm.chat({
        role: 'coder',
        messages: [
          { role: 'system', content: 'Translate the Minecraft bot task into one short English sentence. Reply with ONLY the translation.' },
          { role: 'user', content: task }
        ],
        maxTokens: 60,
        temperature: 0
      })
      const t = String(r.content || '').trim().replace(/^["']|["']$/g, '')
      if (t && !/[\u0400-\u04FF]/.test(t)) return t
    } catch {}
    return task
  }
}

export function learningSkills (ctx, library) {
  const synth = new SkillSynthesizer(ctx, library)
  const { say, cfg } = ctx
  return [
    {
      name: 'learn_skill',
      description: 'Научиться новому навыку, которого нет среди инструментов: бот сам напишет и проверит код (Mineflayer JS), затем сохранит навык. Используй, когда ни один инструмент не подходит.',
      params: z.object({
        task: z.string().describe('подробное описание задачи на английском, напр. "build a 3-block tall cobblestone pillar and stand on top"'),
        skill_name: z.string().optional().describe('snake_case имя функции'),
        args: z.record(z.string(), z.any()).optional().describe('параметры, напр. {"count": 3}')
      }),
      long: true,
      ack: () => 'Этот навык мне пока неизвестен, пробую написать алгоритм…',
      async run (args, signal) {
        const taskEn = await synth.toEnglish(args.task)
        const similar = (await library.search(taskEn, 1))[0]
        ctx.log.debug({ taskEn, similar: similar && { name: similar.name, similarity: +similar.similarity.toFixed(3) } }, 'skill search')
        if (similar && similar.similarity >= cfg.skillLibrary.minSimilarity) {
          say(`Похоже, я это уже умею (${similar.name}), пробую.`)
          const { result } = await library.sandbox.run(similar.code, similar.name, args.args || {}, signal)
          return `Выполнил выученный навык ${similar.name}: ${result}`
        }
        const out = await synth.enqueue(() => synth.synthesize({ task: `${args.task}${taskEn !== args.task ? ` (${taskEn})` : ''}`, skillName: args.skill_name, args: args.args || {}, signal, onProgress: say }))
        await library.add({ name: out.name, description: taskEn, task: args.task, code: out.code, tags: tagsFrom(taskEn), createdAt: new Date().toISOString() })
        return `Научился навыку ${out.name} (попыток: ${out.attempts}). Результат: ${out.result}`
      }
    },
    {
      name: 'list_learned_skills',
      description: 'Показать выученные навыки.',
      params: z.object({}),
      async run () {
        const list = library.listLearned()
        return list.length ? list.map(s => `${s.name}: ${s.task || s.description}`).join('; ') : 'Пока ничего не выучил.'
      }
    },
    {
      name: 'forget_skill',
      description: 'Удалить выученный навык по имени (если он работает плохо).',
      params: z.object({ name: z.string() }),
      async run (args) {
        const { default: fs } = await import('node:fs')
        const { default: path } = await import('node:path')
        for (const ext of ['.json', '.js']) { const f = path.join(library.codeDir, args.name + ext); if (fs.existsSync(f)) fs.unlinkSync(f) }
        await library.table.delete(`name = '${args.name.replace(/'/g, "''")}'`)
        ctx.registry.skills.delete(args.name)
        return `Забыл навык ${args.name}.`
      }
    }
  ]
}

function extractCode (text) {
  if (!text) return null
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/)
  const code = (m ? m[1] : text).trim()
  return /async\s+function/.test(code) ? code : null
}

function sanitizeName (s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 48)
}

function tagsFrom (task) {
  return [...new Set((task.toLowerCase().match(/[a-z_]{4,}/g) || []).filter(w => !['with', 'that', 'this', 'then', 'from', 'into', 'near', 'the', 'and'].includes(w)))].slice(0, 8)
}
