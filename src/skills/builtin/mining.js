import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export function matchBlockName (query) {
  const q = String(query).toLowerCase().replace(/^minecraft:/, '').replace(/ /g, '_')
  const aliases = { wood: 'log', logs: 'log', log: 'log', tree: 'log', stone: 'stone', cobble: 'cobblestone', dirt: 'dirt', sand: 'sand', iron: 'iron_ore', coal: 'coal_ore', gold: 'gold_ore', diamond: 'diamond_ore', copper: 'copper_ore', gravel: 'gravel' }
  const base = aliases[q] ?? q
  return (b) => {
    if (!b || !b.name) return false
    const n = b.name
    if (n === base) return true
    if (base === 'log') return n.endsWith('_log') || n.endsWith('_stem')
    if (base === 'cobblestone') return n === 'stone' || n === 'cobblestone'
    if (base.endsWith('_ore')) return n === base || n === `deepslate_${base}`
    if (n.endsWith(`_${base}`)) return true
    return false
  }
}

export default function miningSkills (ctx) {
  const { bot, h, cfg } = ctx
  return [
    {
      name: 'collect_block',
      description: 'Добыть/собрать блоки указанного типа поблизости (камень, руда, дерево, песок…). Бот сам подбирает инструмент.',
      params: z.object({
        block: z.string().describe('английское имя блока, напр. stone/cobblestone (камень), oak_log, iron_ore, log (любое дерево), dirt, sand'),
        count: z.number().int().min(1).max(256).default(1),
        max_distance: z.number().default(48)
      }),
      long: true,
      ack: a => `Иду добывать ${a.block} x${a.count}.`,
      async run (args, signal) {
        const match = matchBlockName(args.block)
        const target = (b) => match(b) && !cfg.safety.forbiddenDigBlocks.includes(b.name)
        let collected = 0
        const before = h.inventoryFillRatio()
        for (let i = 0; i < args.count * 3 && collected < args.count; i++) {
          throwIfAborted(signal)
          const positions = bot.findBlocks({ matching: target, maxDistance: args.max_distance, count: 8 })
          if (!positions.length) {
            if (collected === 0) throw new Error(`не вижу ${args.block} в радиусе ${args.max_distance}`)
            break
          }
          const blocks = positions.map(p => bot.blockAt(p)).filter(Boolean)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
          const block = blocks[0]
          const onAbort = () => bot.collectBlock.cancelTask?.()
          signal.addEventListener('abort', onAbort, { once: true })
          try {
            await bot.collectBlock.collect(block, { ignoreNoPath: true })
            collected++
          } catch (e) {
            throwIfAborted(signal)
            if (/No pickup|path|Path/i.test(e.message)) { await sleep(300, signal); continue }
            if (/tool|harvest/i.test(e.message)) throw new Error(`нужен инструмент, чтобы добыть ${block.name}: ${e.message}`)
            throw e
          } finally { signal.removeEventListener('abort', onAbort) }
          if (h.inventoryFillRatio() > 0.95) return `Собрал ${collected} ${args.block}, инвентарь полон.`
        }
        void before
        return `Собрал ${collected} ${args.block}.`
      }
    },
    {
      name: 'dig_block_at',
      description: 'Сломать один блок по координатам.',
      params: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      long: true,
      ack: a => `Ломаю блок на (${a.x}, ${a.y}, ${a.z}).`,
      async run (args, signal) {
        const name = await h.digAt(new h.Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z)), signal)
        return `Сломал ${name}.`
      }
    }
  ]
}
