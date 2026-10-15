import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export function isKitItem (name, kit) { return kit.some(k => name.includes(k)) }

export default function inventorySkills (ctx) {
  const { bot, h, cfg, memory } = ctx

  async function findChestNear (maxDistance = 32) {
    const known = memory.get('baseChests', [])
    const candidates = known.map(c => bot.blockAt(new h.Vec3(c.x, c.y, c.z))).filter(b => b && b.name.includes('chest'))
    if (candidates.length) return candidates.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    return h.findBlock(b => b.name === 'chest' || b.name === 'barrel' || b.name === 'trapped_chest', maxDistance)
  }

  async function deposit (keepKit, signal, itemFilter = null) {
    const chest = await findChestNear()
    if (!chest) throw new Error('не нашёл сундук поблизости (поставь сундук или скажи "это база" рядом с сундуками)')
    await h.gotoNear(chest.position, 2, signal)
    throwIfAborted(signal)
    const container = await bot.openContainer(chest)
    let moved = 0
    try {
      const items = bot.inventory.items().filter(i => (itemFilter ? itemFilter(i) : true) && !(keepKit && isKitItem(i.name, cfg.autonomy.travelKit)))
      const order = ['_ore', 'raw_', 'stone', 'cobble', 'dirt', 'log', 'planks', 'sand', 'gravel', 'seeds', 'wheat', 'beef', 'pork', 'mutton', 'chicken']
      items.sort((a, b) => order.findIndex(o => a.name.includes(o)) - order.findIndex(o => b.name.includes(o)))
      for (const it of items) {
        throwIfAborted(signal)
        try { await container.deposit(it.type, null, it.count); moved += it.count } catch (e) { if (/full|space/i.test(e.message)) break; throw e }
      }
    } finally { container.close() }
    return moved
  }

  return [
    {
      name: 'list_inventory',
      description: 'Перечислить содержимое инвентаря.',
      params: z.object({}),
      async run () {
        const inv = {}
        for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
        const s = Object.entries(inv).map(([k, v]) => `${k} x${v}`).join(', ')
        return s || 'Инвентарь пуст.'
      }
    },
    {
      name: 'give_item',
      description: 'Отдать (выбросить рядом с игроком) предметы игроку.',
      params: z.object({ player: z.string(), item: z.string(), count: z.number().int().min(1).default(1) }),
      long: true,
      ack: a => `Несу ${a.item} x${a.count} игроку ${a.player}.`,
      async run (args, signal) {
        const item = h.itemByName(args.item)
        if (!item) throw new Error(`у меня нет ${args.item}`)
        const e = h.playerEntity(args.player)
        if (!e) throw new Error(`игрок ${args.player} не виден`)
        await h.gotoNear(e.position, 2, signal)
        const target = h.playerEntity(args.player)
        if (target) await bot.lookAt(target.position.offset(0, 1.2, 0))
        const n = Math.min(args.count, h.countItem(item.name))
        await bot.toss(item.type, null, n)
        return `Отдал ${n} ${item.name} игроку ${args.player}.`
      }
    },
    {
      name: 'equip_item',
      description: 'Взять предмет в руку или надеть броню.',
      params: z.object({ item: z.string(), destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).default('hand') }),
      async run (args) {
        const it = await h.equipItem(args.item, args.destination)
        return `Экипировал ${it.name}.`
      }
    },
    {
      name: 'deposit_items',
      description: 'Сложить добычу в ближайший сундук (на базе), оставив себе походный набор инструментов и еды.',
      params: z.object({ keep_kit: z.boolean().default(true), only_item: z.string().optional() }),
      long: true,
      ack: () => 'Иду складывать вещи в сундук.',
      async run (args, signal) {
        const filter = args.only_item ? (i) => i.name.includes(args.only_item) : null
        const moved = await deposit(args.keep_kit, signal, filter)
        return `Сложил в сундук ${moved} предметов.`
      }
    },
    {
      name: 'withdraw_item',
      description: 'Взять предмет из ближайшего сундука.',
      params: z.object({ item: z.string(), count: z.number().int().min(1).default(1) }),
      long: true,
      ack: a => `Иду за ${a.item} в сундук.`,
      async run (args, signal) {
        const chest = await findChestNear()
        if (!chest) throw new Error('не нашёл сундук поблизости')
        await h.gotoNear(chest.position, 2, signal)
        const c = await bot.openContainer(chest)
        try {
          const it = c.containerItems().find(i => i.name === args.item || i.name.endsWith(`_${args.item}`))
          if (!it) return `В сундуке нет ${args.item}.`
          const n = Math.min(args.count, c.containerItems().filter(i => i.name === it.name).reduce((s, i) => s + i.count, 0))
          await c.withdraw(it.type, null, n)
          return `Взял ${n} ${it.name}.`
        } finally { c.close() }
      }
    },
    {
      name: 'set_base_here',
      description: 'Запомнить текущее место как базу (и все сундуки рядом).',
      params: z.object({}),
      async run () {
        const p = bot.entity.position.floored()
        const chests = h.findBlocks(b => b.name === 'chest' || b.name === 'barrel' || b.name === 'trapped_chest', 16, 32).map(v => ({ x: v.x, y: v.y, z: v.z }))
        memory.set('base', { x: p.x, y: p.y, z: p.z })
        memory.set('baseChests', chests)
        return `Запомнил базу на ${h.fmt(p)}, сундуков рядом: ${chests.length}.`
      }
    },
    {
      name: 'go_to_base',
      description: 'Вернуться на базу.',
      params: z.object({}),
      long: true,
      ack: () => 'Возвращаюсь на базу.',
      async run (args, signal) {
        const b = memory.get('base')
        if (!b) throw new Error('база ещё не задана — скажи "это база", когда будешь на месте')
        await h.gotoNear(b, 2, signal)
        return 'Я на базе.'
      }
    }
  ]
}

export { sleep }
