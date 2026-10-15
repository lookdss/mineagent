import { HOSTILE } from '../skills/builtin/combat.js'
import { isKitItem } from '../skills/builtin/inventory.js'
import { sleep } from './taskManager.js'

/**
 * Local reflexes and idle behaviour that never call the LLM:
 * eating (auto-eat plugin), fight/flee, deposit loot, find food when hungry and out of food.
 */
export class Autonomy {
  constructor ({ bot, cfg, log, h, tasks, registry, memory, say, agent, llm }) {
    Object.assign(this, { bot, cfg, log, h, tasks, registry, memory, say, agent, llm })
    this.timer = null
    this.lastWarn = {}
    this.lastThink = Date.now()
  }

  start () {
    this.timer = setInterval(() => this.tick().catch(e => this.log.debug({ err: e.message }, 'autonomy tick failed')), this.cfg.autonomy.tickMs)
    this.bot.on('health', () => this.onHealth())
    this.bot.on('death', () => this.tasks.cancel('died'))
    this.log.info('autonomy enabled')
  }

  stop () { clearInterval(this.timer) }

  warnOnce (key, text, everyMs = 120000) {
    const now = Date.now()
    if ((this.lastWarn[key] || 0) + everyMs > now) return
    this.lastWarn[key] = now
    this.say(text)
  }

  nearestHostile (range) {
    return this.h.nearestEntity(e => e.name && HOSTILE.has(e.name), range)
  }

  async onHealth () {
    const a = this.cfg.autonomy
    if (this.bot.health <= a.fleeBelowHealth && this.nearestHostile(8) && this.tasks.active?.name !== 'flee') {
      await this.internal('flee', 10, async (signal) => {
        const mob = this.nearestHostile(12)
        const base = this.memory.get('base')
        let target
        if (base && this.bot.entity.position.distanceTo(base) > 6) target = base
        else if (mob) { const dir = this.bot.entity.position.minus(mob.position).normalize().scaled(14); target = this.bot.entity.position.plus(dir) }
        if (!target) return
        this.say('Мало здоровья — отступаю!')
        await this.h.gotoNear(target, 2, signal).catch(() => {})
        await sleep(3000, signal)
      })
    }
  }

  async internal (name, priority, fn) {
    if (this.tasks.active && this.tasks.active.priority >= priority) return false
    try {
      await this.tasks.run(name, fn, { requester: 'self', priority, cancelCurrent: true })
      return true
    } catch (e) {
      this.log.debug({ task: name, err: e.message }, 'internal task failed')
      return false
    }
  }

  async runSkill (name, args, signal) {
    const s = this.registry.get(name)
    if (!s) throw new Error(`no skill ${name}`)
    const v = this.registry.validate(name, args)
    if (!v.ok) throw new Error(v.error)
    return s.run(v.value, signal)
  }

  async tick () {
    if (!this.bot.entity || this.bot.health == null) return
    const a = this.cfg.autonomy

    // 1. Threats
    const hostile = this.nearestHostile(a.fightHostilesWithin)
    if (hostile && this.bot.health > a.fleeBelowHealth && !this.tasks.busy) {
      await this.internal('defend', 5, async (signal) => {
        this.say(`Рядом ${hostile.name} — защищаюсь.`)
        return this.runSkill('attack_entity', { target: hostile.name, count: 1 }, signal)
      })
      return
    }
    if (this.tasks.busy) return

    // 2. Food
    const foodItems = this.bot.inventory.items().filter(i => this.bot.registry.foodsByName?.[i.name] && !/rotten|spider_eye|poisonous|pufferfish/.test(i.name))
    if (this.bot.food < a.eatBelowFood && foodItems.length === 0) {
      const raw = this.bot.inventory.items().find(i => /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/.test(i.name))
      if (raw) {
        await this.internal('cook_food', 3, async (signal) => {
          this.say('Еда закончилась — готовлю мясо в печи.')
          return this.runSkill('smelt_item', { item: raw.name, count: raw.count, fuel: 'coal' }, signal)
        })
      } else {
        const ok = await this.internal('find_food', 3, async (signal) => {
          this.say('Голоден и без еды — ищу урожай или дичь.')
          try { const r = await this.runSkill('harvest_crops', { replant: true }, signal); if (!/нет/.test(r)) return r } catch {}
          return this.runSkill('hunt_for_food', { count: 2 }, signal)
        })
        if (!ok) this.warnOnce('nofood', 'Не могу найти еду поблизости. Поделись чем-нибудь?')
      }
      return
    }

    // 3. Inventory
    if (this.h.inventoryFillRatio() >= a.depositWhenInventoryAbove) {
      const nonKit = this.bot.inventory.items().filter(i => !isKitItem(i.name, a.travelKit))
      if (nonKit.length) {
        const ok = await this.internal('deposit', 2, async (signal) => {
          this.say('Рюкзак почти полон — отнесу добычу в сундук.')
          return this.runSkill('deposit_items', { keep_kit: true }, signal)
        })
        if (!ok) this.warnOnce('nochest', 'Инвентарь почти полон, а сундука рядом нет. Поставь сундук и скажи «это база».')
        return
      }
    }

    // 4. Optional LLM-driven idle thinking
    if (a.idleThinkEveryMs > 0 && Date.now() - this.lastThink > a.idleThinkEveryMs && this.agent) {
      this.lastThink = Date.now()
      this.agent.handleChat('self', `${this.cfg.bot.triggerNames[0]}, ты свободен. Выбери одно полезное действие для базы (сложить вещи, собрать урожай, срубить дерево с пересадкой) или ничего не делай.`, { whisper: true })
    }
  }
}
