import vm from 'node:vm'
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'

const { goals, Movements } = pf
const FORBIDDEN = [
  /\brequire\s*\(/, /\bimport\s*[\(\s{]/, /\bprocess\b/, /\bglobalThis\b/, /\bchild_process\b/, /\beval\s*\(/, /\bFunction\s*\(/,
  /__proto__/, /\bconstructor\s*\[/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/,
  /\bbot\s*\.\s*(quit|end|_client)\b/, /\bsetInterval\s*\(/
]

/** Static safety screen for generated code. Returns an error string or null. */
export function staticCheck (code) {
  for (const re of FORBIDDEN) if (re.test(code)) return `forbidden construct: ${re.source}`
  if (!/async\s+function\s+[A-Za-z_$][\w$]*\s*\(/.test(code)) return 'code must define exactly one `async function name(bot, args)`'
  return null
}

export function extractFunctionName (code) {
  return code.match(/async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? null
}

/**
 * Runs generated skill code inside a node:vm context with a whitelisted scope and a hard timeout.
 * NOTE: node:vm is not a hard security boundary; this isolates scope/globals and bounds runtime
 * for code produced by the local model. Static checks above block the obvious escape hatches.
 */
export class Sandbox {
  constructor (ctx, timeoutMs = 30000) {
    this.ctx = ctx
    this.timeoutMs = timeoutMs
  }

  compile (code, name) {
    const err = staticCheck(code)
    if (err) throw new SandboxError(err, null)
    const fnName = extractFunctionName(code)
    const wrapped = `${code}\n;${fnName}`
    const script = new vm.Script(wrapped, { filename: `skill_${name}.js` })
    const { bot, h, log, say, cfg } = this.ctx
    const helpers = {
      findBlocks: (m, d, c) => h.findBlocks(m, d, c),
      findBlock: (m, d) => h.findBlock(m, d),
      gotoNear: (p, r) => h.gotoNear(p, r, this.currentSignal),
      countItem: h.countItem,
      itemByName: h.itemByName,
      equipItem: h.equipItem,
      placeBlockAt: (i, p) => h.placeBlockAt(i, p, this.currentSignal),
      digAt: (p) => h.digAt(p, this.currentSignal),
      craft: (i, n) => h.craft(i, n, this.currentSignal),
      nearestEntity: h.nearestEntity,
      playerEntity: h.playerEntity,
      fmt: h.fmt
    }
    const logs = []
    const sandbox = {
      bot,
      Vec3,
      goals,
      Movements,
      mcData: bot.registry,
      helpers,
      ...helpers, // те же функции доступны и без префикса helpers. — модели часто его забывают
      sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 10000))),
      log: (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logs.push(s); log.debug({ skill: name }, s) },
      say: (t) => say(t),
      console: { log: (...a) => logs.push(a.join(' ')) },
      Math, JSON, Object, Array, Number, String, Boolean, Promise, Error, Map, Set, Date, parseInt, parseFloat, isNaN,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10000)), clearTimeout,
      safety: cfg.safety
    }
    const context = vm.createContext(sandbox, { name: `skill_${name}` })
    const fn = script.runInContext(context, { timeout: 2000 })
    if (typeof fn !== 'function') throw new SandboxError('code did not evaluate to a function', null)
    return { fn, logs, fnName }
  }

  async run (code, name, args = {}, signal) {
    const { fn, logs } = this.compile(code, name)
    this.currentSignal = signal
    const { bot } = this.ctx
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new SandboxError(`timeout after ${this.timeoutMs}ms (skill still running — stopped)`, null)), this.timeoutMs) })
    const abort = new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new SandboxError('cancelled', null)), { once: true }))
    try {
      const result = await Promise.race([fn(bot, args), timeout, abort])
      return { result: result == null ? 'done' : String(result), logs }
    } catch (e) {
      if (e instanceof SandboxError) { this.stopBot(); throw e }
      throw new SandboxError(e.message || String(e), lineFromStack(e.stack, `skill_${name}.js`), logs)
    } finally { clearTimeout(timer) }
  }

  stopBot () {
    const { bot } = this.ctx
    try { bot.pathfinder.stop() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.stopDigging() } catch {}
    bot.clearControlStates()
  }
}

export class SandboxError extends Error {
  constructor (message, line, logs = []) { super(message); this.name = 'SandboxError'; this.line = line; this.logs = logs }
}

function lineFromStack (stack, file) {
  if (!stack) return null
  const m = stack.match(new RegExp(`${file.replace('.', '\\.')}:(\\d+)`))
  return m ? +m[1] : null
}
