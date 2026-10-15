import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export default function craftingSkills (ctx) {
  const { bot, h } = ctx
  return [
    {
      name: 'craft_item',
      description: 'Скрафтить предмет (при необходимости использует/ставит верстак). Нужны ингредиенты в инвентаре.',
      params: z.object({ item: z.string().describe('английский id предмета, напр. wooden_pickaxe, oak_planks, stick, torch'), count: z.number().int().min(1).default(1) }),
      long: true,
      ack: a => `Крафчу ${a.item} x${a.count}.`,
      async run (args, signal) {
        const r = await h.craft(args.item, args.count, signal)
        return r.replace('crafted', 'Скрафтил')
      }
    },
    {
      name: 'smelt_item',
      description: 'Переплавить/приготовить предметы в печи (сырое мясо, руда). Нужны топливо и печь поблизости.',
      params: z.object({ item: z.string(), count: z.number().int().min(1).default(1), fuel: z.string().default('coal') }),
      long: true,
      ack: a => `Иду к печи готовить ${a.item}.`,
      async run (args, signal) {
        let furnace = h.findBlock(b => b.name === 'furnace' || b.name === 'smoker' || b.name === 'blast_furnace', 32)
        if (!furnace) {
          if (h.countItem('furnace') === 0) {
            if (h.countItem('cobblestone') >= 8) await h.craft('furnace', 1, signal)
            else throw new Error('нет печи поблизости и не из чего её сделать (нужно 8 cobblestone)')
          }
          const spot = bot.entity.position.floored().offset(1, 0, 1)
          await h.placeBlockAt('furnace', spot, signal)
          furnace = bot.blockAt(spot)
        }
        const input = h.itemByName(args.item)
        if (!input) throw new Error(`у меня нет ${args.item}`)
        const fuel = h.itemByName(args.fuel) || h.itemByName('coal') || h.itemByName('charcoal') || bot.inventory.items().find(i => i.name.endsWith('_planks') || i.name.endsWith('_log'))
        if (!fuel) throw new Error('нет топлива (уголь, доски, брёвна)')
        await h.gotoNear(furnace.position, 2, signal)
        const f = await bot.openFurnace(furnace)
        try {
          const n = Math.min(args.count, h.countItem(input.name))
          const fuelNeeded = Math.max(1, Math.ceil(n / (fuel.name.includes('coal') ? 8 : 1.5)))
          if (!f.fuelItem() || f.fuel < 0.1) await f.putFuel(fuel.type, null, Math.min(fuelNeeded, h.countItem(fuel.name)))
          await f.putInput(input.type, null, n)
          const deadline = Date.now() + n * 10500 + 3000
          let out = 0
          while (Date.now() < deadline) {
            throwIfAborted(signal)
            await sleep(1000, signal)
            const o = f.outputItem()
            if (o && o.count >= n) { await f.takeOutput(); out = o.count; break }
            if (!f.inputItem() && o) { await f.takeOutput(); out = o.count; break }
          }
          return `Приготовил ${out} из ${input.name}.`
        } finally { f.close() }
      }
    }
  ]
}
