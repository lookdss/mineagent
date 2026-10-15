import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

const CROPS = {
  wheat: { seed: 'wheat_seeds', maxAge: 7 },
  carrots: { seed: 'carrot', maxAge: 7 },
  potatoes: { seed: 'potato', maxAge: 7 },
  beetroots: { seed: 'beetroot_seeds', maxAge: 3 }
}

export default function farmingSkills (ctx) {
  const { bot, h } = ctx

  async function hoeAndPlant (pos, seedName, signal) {
    const b = bot.blockAt(pos)
    if (!b || !/^(grass_block|dirt)$/.test(b.name)) return false
    const above = bot.blockAt(pos.offset(0, 1, 0))
    if (above && above.name !== 'air' && !above.name.includes('grass')) return false
    const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'))
    if (!hoe) throw new Error('нужна мотыга (hoe)')
    if (above && above.name !== 'air') await h.digAt(above.position, signal)
    await h.gotoNear(pos, 2.5, signal)
    await bot.equip(hoe, 'hand')
    await bot.activateBlock(b)
    await sleep(150, signal)
    if (bot.blockAt(pos)?.name !== 'farmland') return false
    const seed = h.itemByName(seedName)
    if (seed) {
      await bot.equip(seed, 'hand')
      await bot.placeBlock(bot.blockAt(pos), new h.Vec3(0, 1, 0)).catch(() => {})
    }
    return true
  }

  return [
    {
      name: 'make_farm',
      description: 'Сделать грядки у воды: найти воду, вспахать землю в радиусе увлажнения (до 4 блоков), посадить семена.',
      params: z.object({ crop: z.enum(['wheat', 'carrots', 'potatoes', 'beetroots']).default('wheat'), max_plots: z.number().int().min(1).max(80).default(20) }),
      long: true,
      ack: a => `Ищу воду и делаю грядки под ${a.crop}.`,
      async run (args, signal) {
        const water = h.findBlock('water', 48)
        if (!water) throw new Error('не нашёл воду поблизости для грядок')
        const seedName = CROPS[args.crop].seed
        if (!h.itemByName(seedName)) ctx.say(`У меня нет ${seedName}, вспашу без посадки.`)
        let made = 0
        const w = water.position
        const cells = []
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) if (dx || dz) cells.push(w.offset(dx, 0, dz))
        cells.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        for (const c of cells) {
          throwIfAborted(signal)
          if (made >= args.max_plots) break
          try { if (await hoeAndPlant(c, seedName, signal)) made++ } catch (e) { if (/мотыга/.test(e.message)) throw e; ctx.log.debug({ err: e.message }, 'plot failed') }
        }
        return `Сделал грядок: ${made} около воды ${h.fmt(w)}.`
      }
    },
    {
      name: 'harvest_crops',
      description: 'Собрать созревший урожай на грядках поблизости и пересадить заново.',
      params: z.object({ replant: z.boolean().default(true), max_distance: z.number().default(32) }),
      long: true,
      ack: () => 'Иду собирать урожай.',
      async run (args, signal) {
        let harvested = 0
        const ripe = (b) => { const c = CROPS[b.name]; if (!c) return false; const age = b.getProperties?.()?.age; return age !== undefined && age >= c.maxAge }
        for (let i = 0; i < 64; i++) {
          throwIfAborted(signal)
          const pos = h.findBlocks(ripe, args.max_distance, 1)[0]
          if (!pos) break
          const crop = bot.blockAt(pos); const seedName = CROPS[crop.name].seed
          await h.gotoNear(pos, 2.5, signal)
          await bot.dig(crop, true)
          harvested++
          await sleep(400, signal)
          await ctx.helpersPickup?.(signal)
          if (args.replant) {
            const seed = h.itemByName(seedName)
            const farmland = bot.blockAt(pos.offset(0, -1, 0))
            if (seed && farmland?.name === 'farmland') { await bot.equip(seed, 'hand'); await bot.placeBlock(farmland, new h.Vec3(0, 1, 0)).catch(() => {}) }
          }
        }
        if (!harvested) return 'Созревшего урожая поблизости нет.'
        return `Собрал урожая: ${harvested}${args.replant ? ', пересадил' : ''}.`
      }
    }
  ]
}
