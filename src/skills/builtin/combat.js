import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'phantom', 'slime', 'zombie_villager', 'blaze', 'ghast', 'piglin', 'hoglin', 'zoglin', 'wither_skeleton', 'bogged', 'breeze', 'silverfish', 'endermite', 'ravager', 'evoker', 'vex', 'guardian', 'warden'])
export const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])

export default function combatSkills (ctx) {
  const { bot, h } = ctx

  async function equipBestWeapon () {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
    for (const n of order) { const it = h.itemByName(n); if (it) { await bot.equip(it, 'hand'); return n } }
    return null
  }

  async function attackEntity (entity, signal, timeoutMs = 30000) {
    await equipBestWeapon()
    const end = Date.now() + timeoutMs
    bot.pvp.attack(entity)
    const onAbort = () => bot.pvp.stop()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (Date.now() < end) {
        await sleep(300, signal)
        if (!entity.isValid || !bot.entities[entity.id]) return true
      }
      return false
    } finally { bot.pvp.stop(); signal.removeEventListener('abort', onAbort) }
  }

  return [
    {
      name: 'attack_entity',
      description: 'Атаковать ближайшего моба/животное указанного типа (zombie, cow, …) или игрока по имени.',
      params: z.object({ target: z.string(), count: z.number().int().min(1).max(10).default(1) }),
      long: true,
      ack: a => `Атакую ${a.target}.`,
      async run (args, signal) {
        let killed = 0
        for (let i = 0; i < args.count; i++) {
          throwIfAborted(signal)
          const t = String(args.target).toLowerCase()
          const e = h.nearestEntity(e => (e.name && e.name.toLowerCase() === t) || (e.type === 'player' && e.username === args.target), 32)
          if (!e) { if (!killed) throw new Error(`не вижу ${args.target} поблизости`); break }
          if (await attackEntity(e, signal)) killed++
        }
        return `Победил: ${killed} ${args.target}.`
      }
    },
    {
      name: 'hunt_for_food',
      description: 'Поохотиться на ближайших мирных животных ради еды и собрать дроп.',
      params: z.object({ count: z.number().int().min(1).max(10).default(2) }),
      long: true,
      ack: () => 'Иду на охоту за едой.',
      async run (args, signal) {
        let killed = 0
        for (let i = 0; i < args.count; i++) {
          throwIfAborted(signal)
          const e = h.nearestEntity(e => e.name && FOOD_ANIMALS.has(e.name), 48)
          if (!e) { if (!killed) throw new Error('не вижу животных поблизости'); break }
          const pos = e.position.clone()
          if (await attackEntity(e, signal)) killed++
          await sleep(500, signal)
          const drop = h.nearestEntity(x => x.name === 'item', 6)
          if (drop) await h.gotoNear(drop.position, 0.5, signal).catch(() => {})
          else await h.gotoNear(pos, 0.5, signal).catch(() => {})
        }
        return `Добыл еды с ${killed} животных.`
      }
    }
  ]
}
