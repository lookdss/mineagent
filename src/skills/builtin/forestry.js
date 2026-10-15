import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export default function forestrySkills (ctx) {
  const { bot, h } = ctx

  function treeBlocks (base) {
    // flood-fill connected logs of the same type starting from base
    const seen = new Set(); const out = []; const stack = [base.position]
    const name = base.name
    while (stack.length && out.length < 64) {
      const p = stack.pop(); const k = `${p.x},${p.y},${p.z}`
      if (seen.has(k)) continue; seen.add(k)
      const b = bot.blockAt(p); if (!b || b.name !== name) continue
      out.push(b)
      for (const d of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) stack.push(p.offset(...d))
    }
    return out
  }

  async function pickupNearbyItems (signal, radius = 6, ms = 4000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      throwIfAborted(signal)
      const item = h.nearestEntity(e => e.name === 'item' || e.objectType === 'Item', radius)
      if (!item) { await sleep(500, signal); continue }
      try { await h.gotoNear(item.position, 0.5, signal) } catch { break }
    }
  }

  return [
    {
      name: 'chop_tree',
      description: 'Срубить дерево(я) целиком, собрать брёвна и саженцы, посадить саженец обратно.',
      params: z.object({ count: z.number().int().min(1).max(20).default(1), replant: z.boolean().default(true) }),
      long: true,
      ack: a => `Иду рубить дерево${a.count > 1 ? ' x' + a.count : ''}.`,
      async run (args, signal) {
        let logs = 0; let trees = 0
        for (let t = 0; t < args.count; t++) {
          throwIfAborted(signal)
          const isLog = b => b.name.endsWith('_log') || b.name.endsWith('_stem')
          const logBlocks = bot.findBlocks({ matching: isLog, maxDistance: 48, count: 512 }).map(p => bot.blockAt(p)).filter(Boolean)
          const dist = b => b.position.distanceTo(bot.entity.position)
          let base = logBlocks.filter(b => /dirt|grass|podzol|mud|moss|rooted/.test(bot.blockAt(b.position.offset(0, -1, 0))?.name ?? '')).sort((a, b) => dist(a) - dist(b))[0]
          if (!base && logBlocks.length) {
            // ствол уходит ниже загруженной/видимой зоны — спускаемся по логам до нижнего
            let cur = logBlocks.sort((a, b) => dist(a) - dist(b))[0]
            for (let i = 0; i < 40; i++) { const below = bot.blockAt(cur.position.offset(0, -1, 0)); if (below && isLog(below)) cur = below; else break }
            base = cur
          }
          if (!base) { if (trees === 0) throw new Error('не вижу деревьев поблизости'); break }
          const basePos = base.position.clone(); const kind = base.name.replace(/_log|_stem/, '')
          const blocks = treeBlocks(base).sort((a, b) => a.position.y - b.position.y)
          for (const b of blocks) {
            throwIfAborted(signal)
            const cur = bot.blockAt(b.position); if (!cur || cur.name !== base.name) continue
            try { await bot.collectBlock.collect(cur, { ignoreNoPath: true }); logs++ } catch (e) { throwIfAborted(signal); if (!/path/i.test(e.message)) throw e }
          }
          trees++
          await pickupNearbyItems(signal, 8, 5000)
          if (args.replant) {
            const sapling = bot.inventory.items().find(i => i.name === `${kind}_sapling`) || bot.inventory.items().find(i => i.name.endsWith('_sapling'))
            if (sapling) {
              try { await h.placeBlockAt(sapling.name, basePos, signal) } catch (e) { ctx.log.debug({ err: e.message }, 'replant failed') }
            }
          }
        }
        return `Срубил деревьев: ${trees}, брёвен собрано: ${logs}.`
      }
    }
  ]
}
