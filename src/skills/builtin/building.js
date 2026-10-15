import { z } from 'zod'
import { throwIfAborted } from '../../bot/taskManager.js'

const CLEARABLE = /^(short_grass|tall_grass|grass|fern|large_fern|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|dead_bush|snow|.*_sapling|sweet_berry_bush|vine|.*_leaves)$/

/** Parametric blueprints: return array of { x, y, z, item } relative to origin (y=0 is ground+1). */
export const BLUEPRINTS = {
  house ({ width = 5, depth = 5, height = 3, material = 'oak_planks' }) {
    const blocks = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
        const wall = x === 0 || z === 0 || x === width - 1 || z === depth - 1
        if (!wall) continue
        const isDoor = y < 2 && x === Math.floor(width / 2) && z === 0
        if (isDoor) continue
        blocks.push({ x, y, z, item: material })
      }
    }
    for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) blocks.push({ x, y: height, z, item: material })
    return blocks
  },
  pen ({ width = 6, depth = 6, material = 'oak_fence' }) {
    const blocks = []
    for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) {
      const edge = x === 0 || z === 0 || x === width - 1 || z === depth - 1
      if (!edge) continue
      if (x === Math.floor(width / 2) && z === 0) { blocks.push({ x, y: 0, z, item: material.replace('_fence', '_fence_gate') }); continue }
      blocks.push({ x, y: 0, z, item: material })
    }
    return blocks
  },
  wall ({ width = 5, height = 2, material = 'cobblestone' }) {
    const blocks = []
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) blocks.push({ x, y, z: 0, item: material })
    return blocks
  },
  platform ({ width = 5, depth = 5, material = 'cobblestone' }) {
    const blocks = []
    for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) blocks.push({ x, y: -1, z, item: material })
    return blocks
  },
  storage ({ width = 3 }) {
    const blocks = []
    for (let x = 0; x < width; x++) blocks.push({ x, y: 0, z: 0, item: 'chest' })
    return blocks
  },
  pillar ({ height = 3, material = 'cobblestone' }) {
    return Array.from({ length: height }, (_, y) => ({ x: 0, y, z: 0, item: material }))
  }
}

export default function buildingSkills (ctx) {
  const { bot, h, cfg } = ctx

  function groundY (x, z, fromY) {
    for (let y = fromY + 12; y > fromY - 40; y--) {
      const b = bot.blockAt(new h.Vec3(x, y, z))
      if (b && b.boundingBox === 'block' && !CLEARABLE.test(b.name)) return y
    }
    return null
  }

  function assessTerrain (origin, width, depth) {
    const hs = []
    for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) { const y = groundY(origin.x + x, origin.z + z, origin.y); if (y != null) hs.push(y) }
    if (!hs.length) return null
    const avg = hs.reduce((a, b) => a + b, 0) / hs.length
    return { min: Math.min(...hs), max: Math.max(...hs), avg: Math.round(avg), spread: Math.max(...hs) - Math.min(...hs) }
  }

  async function clearArea (origin, width, depth, height, signal) {
    let cleared = 0
    for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) for (let y = 0; y <= height; y++) {
      throwIfAborted(signal)
      const p = new h.Vec3(origin.x + x, origin.y + y, origin.z + z)
      const b = bot.blockAt(p)
      if (b && CLEARABLE.test(b.name)) { try { await h.digAt(p, signal); cleared++ } catch {} }
    }
    return cleared
  }

  async function buildBlueprint (origin, blocks, signal) {
    const needed = {}
    for (const b of blocks) needed[b.item] = (needed[b.item] || 0) + 1
    const missing = Object.entries(needed).filter(([item, n]) => h.countItem(item) < n).map(([item, n]) => `${item}: нужно ${n}, есть ${h.countItem(item)}`)
    if (missing.length) throw new Error(`не хватает материалов — ${missing.join('; ')}`)
    const sorted = [...blocks].sort((a, b) => a.y - b.y || (a.x + a.z) - (b.x + b.z))
    let placed = 0; let skipped = 0
    for (const b of sorted) {
      throwIfAborted(signal)
      const p = new h.Vec3(origin.x + b.x, origin.y + b.y, origin.z + b.z)
      const cur = bot.blockAt(p)
      if (cur && cur.name === b.item) { skipped++; continue }
      try { await h.placeBlockAt(b.item, p, signal); placed++ } catch (e) {
        throwIfAborted(signal)
        ctx.log.debug({ err: e.message, p }, 'place failed')
        if (/forbidden/.test(e.message)) throw e
        skipped++
      }
    }
    return { placed, skipped }
  }

  return [
    {
      name: 'place_block',
      description: 'Поставить один блок (сундук, факел, верстак, печь…). Без координат — ставит рядом с собой.',
      params: z.object({ item: z.string(), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }),
      long: true,
      ack: a => a.x != null ? `Ставлю ${a.item} на (${a.x}, ${a.y}, ${a.z}).` : `Ставлю ${a.item} рядом.`,
      async run (args, signal) {
        let pos
        if (args.x != null && args.y != null && args.z != null) pos = new h.Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z))
        else {
          const me = bot.entity.position.floored()
          const yaw = bot.entity.yaw
          const front = new h.Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw)))
          const candidates = [front, new h.Vec3(1, 0, 0), new h.Vec3(-1, 0, 0), new h.Vec3(0, 0, 1), new h.Vec3(0, 0, -1)].map(d => me.plus(d))
          pos = candidates.find(p => { const b = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); return b && (b.name === 'air' || /grass|fern/.test(b.name)) && below && below.boundingBox === 'block' })
          if (!pos) throw new Error('рядом нет свободного места для блока')
        }
        await h.placeBlockAt(args.item, pos, signal)
        return `Поставил ${args.item} на (${pos.x}, ${pos.y}, ${pos.z}).`
      }
    },
    {
      name: 'build_structure',
      description: 'Построить объект по параметрическому чертежу рядом с собой: house (дом), pen (загон), wall (стена), platform (площадка), storage (ряд сундуков), pillar (столб). Сначала оценивает рельеф и чистит только траву.',
      params: z.object({
        type: z.enum(['house', 'pen', 'wall', 'platform', 'storage', 'pillar']),
        width: z.number().int().min(1).max(16).optional(),
        depth: z.number().int().min(1).max(16).optional(),
        height: z.number().int().min(1).max(10).optional(),
        material: z.string().optional(),
        flatten: z.boolean().default(false).describe('разрешить срезать неровности рельефа')
      }),
      long: true,
      ack: a => `Оцениваю площадку и строю ${a.type}.`,
      async run (args, signal) {
        const gen = BLUEPRINTS[args.type]
        const blocks = gen(args)
        const width = Math.max(...blocks.map(b => b.x)) + 1; const depth = Math.max(...blocks.map(b => b.z)) + 1; const height = Math.max(...blocks.map(b => b.y)) + 1
        const start = bot.entity.position.floored().offset(2, 0, 2)
        const terrain = assessTerrain(start, width, depth)
        if (!terrain) throw new Error('не могу оценить рельеф: под площадкой нет твёрдой земли (возможно, я стою на дереве) — отойди на ровное место')
        if (terrain.spread > cfg.safety.maxTerrainVariance && !args.flatten) {
          throw new Error(`площадка ${width}x${depth} неровная (перепад ${terrain.spread} блоков). Скажи «разровняй» (flatten=true) или выбери другое место`)
        }
        const origin = new h.Vec3(start.x, terrain.avg + 1, start.z)
        const cleared = await clearArea(origin, width, depth, height, signal)
        if (args.flatten) {
          for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) for (let y = terrain.max; y > terrain.avg; y--) {
            const p = new h.Vec3(origin.x + x, y, origin.z + z)
            const b = bot.blockAt(p); if (b && b.boundingBox === 'block') await h.digAt(p, signal).catch(() => {})
          }
        }
        const res = await buildBlueprint(origin, blocks, signal)
        return `Построил ${args.type} ${width}x${depth}x${height} на ${h.fmt(origin)}: поставлено ${res.placed}, пропущено ${res.skipped}, расчищено травы ${cleared}.`
      }
    }
  ]
}
