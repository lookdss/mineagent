/** Builds the structured JSON snapshot that is sent to the LLM before each request. */
export function snapshot (bot, tasks, opts = {}) {
  const radius = opts.radius ?? 8
  const pos = bot.entity?.position
  const inv = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
  const held = bot.heldItem?.name ?? 'empty'

  const blockCounts = new Map()
  if (pos) {
    const interesting = bot.findBlocks({
      maxDistance: radius,
      count: 64,
      matching: b => b && b.name !== 'air' && b.name !== 'cave_air' && !/^(grass_block|dirt|stone|deepslate|short_grass|tall_grass|water|sand|gravel|netherrack|bedrock|snow|grass)$/.test(b.name)
    })
    for (const p of interesting) {
      const b = bot.blockAt(p)
      if (!b) continue
      let key = b.name
      const props = b.getProperties?.() || {}
      if (props.age !== undefined) key += `[age=${props.age}]`
      blockCounts.set(key, (blockCounts.get(key) || 0) + 1)
    }
  }
  const nearbyBlocks = [...blockCounts.entries()].sort((a, b) => b[1] - a[1])  .slice(0, opts.maxBlocks ?? 10).map(([k, v]) => v > 1 ? `${k} x${v}` : k)

  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && pos && e.position.distanceTo(pos) <= 16)
    .filter(e => e.type !== 'object' && e.type !== 'orb' && e.name !== 'item')
    .map(e => ({ name: e.type === 'player' ? e.username : (e.name || e.displayName), type: e.type, distance: +e.position.distanceTo(pos).toFixed(1) }))
    .sort((a, b) => a.distance - b.distance).slice(0, opts.maxEntities ?? 6)

  const tod = bot.time?.timeOfDay ?? 0
  const timeOfDay = tod < 12000 ? 'day' : tod < 13800 ? 'dusk' : tod < 22200 ? 'night' : 'dawn'
  const freeSlots = bot.inventory.emptySlotCount?.() ?? (36 - bot.inventory.items().length)

  return {
    self: {
      health: bot.health,
      food: bot.food,
      position: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
      dimension: bot.game?.dimension?.replace('minecraft:', '') ?? 'overworld',
      held_item: held,
      free_inventory_slots: freeSlots
    },
    inventory_summary: inv,
    environment: {
      light_level: pos ? (bot.blockAt(pos)?.light ?? bot.blockAt(pos)?.skyLight ?? null) : null,
      time_of_day: timeOfDay,
      is_raining: !!bot.isRaining,
      nearby_blocks: nearbyBlocks,
      nearby_entities: entities
    },
    active_task: tasks?.describeActive() ?? 'None',
    known_base_chests: (opts.baseChests ?? []).length
  }
}
