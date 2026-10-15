import { EventEmitter } from 'node:events'

/**
 * Single active long-running task with cooperative cancellation via AbortSignal.
 */
export class TaskManager extends EventEmitter {
  constructor (bot, log) {
    super()
    this.bot = bot
    this.log = log
    this.active = null
    this.history = []
  }

  get busy () { return !!this.active }

  describeActive () {
    if (!this.active) return 'None'
    const secs = Math.round((Date.now() - this.active.startedAt) / 1000)
    return `${this.active.name} (${secs}s, by ${this.active.requester || 'self'})`
  }

  /**
   * @param {string} name
   * @param {(signal: AbortSignal) => Promise<any>} fn
   */
  async run (name, fn, { requester, cancelCurrent = true, priority = 0 } = {}) {
    if (this.active) {
      if (!cancelCurrent && this.active.priority >= priority) throw new Error(`busy with ${this.active.name}`)
      await this.cancel(`replaced by ${name}`)
    }
    const ctrl = new AbortController()
    const task = { name, requester, priority, startedAt: Date.now(), ctrl, promise: null }
    this.active = task
    this.emit('start', task)
    task.promise = (async () => {
      try {
        const result = await fn(ctrl.signal)
        this.emit('done', task, result)
        return result
      } catch (err) {
        if (ctrl.signal.aborted) { this.emit('cancelled', task); throw new TaskCancelled(ctrl.signal.reason) }
        this.emit('failed', task, err)
        throw err
      } finally {
        if (this.active === task) this.active = null
        this.history.push({ name, requester, ms: Date.now() - task.startedAt })
        if (this.history.length > 50) this.history.shift()
      }
    })()
    return task.promise
  }

  async cancel (reason = 'cancelled') {
    const t = this.active
    if (!t) return false
    t.ctrl.abort(reason)
    try { this.bot.pathfinder?.stop() } catch {}
    try { this.bot.pathfinder?.setGoal(null) } catch {}
    try { this.bot.stopDigging() } catch {}
    try { this.bot.pvp?.stop() } catch {}
    try { this.bot.collectBlock?.cancelTask?.() } catch {}
    this.bot.clearControlStates()
    await t.promise.catch(() => {})
    return true
  }
}

export class TaskCancelled extends Error {
  constructor (reason) { super(`task cancelled: ${reason}`); this.name = 'TaskCancelled' }
}

export function throwIfAborted (signal) {
  if (signal?.aborted) throw new TaskCancelled(signal.reason)
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new TaskCancelled(signal.reason)) }, { once: true })
})
