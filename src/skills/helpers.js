import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { throwIfAborted, sleep } from '../bot/taskManager.js'

const { goals, Movements } = pf

/** Shared high-level helpers used by builtin skills and by LLM-generated code. */
export function makeHelpers (bot, cfg, log) {
  const mcData = bot.registry

  function itemByName (name) {
    return bot.inventory.items().find(i => i.name === name || i.name.endsWith(`_${name}`) || i.displayName?.toLowerCase() === String(name).toLowerCase())
  }
  function countItem (name) {
    return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
  }
  function findBlocks (matcher, maxDistance = 32, count = 16) {
    const matching = typeof matcher === 'function'
      ? matcher
      : (b) => b && (b.name === matcher || (Array.isArray(matcher) && matcher.includes(b.name)))
    return bot.findBlocks({ matching, maxDistance, count })
  }
  function findBlock (matcher, maxDistance = 32) {
    const res = findBlocks(matcher, maxDistance, 1)
    return res.length ? bot.blockAt(res[0]) : null
  }
  async function gotoNear (pos, range = 1, signal) {
    throwIfAborted(signal)
    const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range)
    const onAbort = () => bot.pathfinder.stop()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.pathfinder.goto(goal)
    } catch (e) {
      throwIfAborted(signal)
      throw new Error(`cannot reach ${fmt(pos)}: ${e.message}`)
    } finally { signal?.removeEventListener('abort', onAbort) }
  }
  async function followEntity (entity, range = 2) {
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
  }
  function stop () {
    try { bot.pathfinder.stop() } catch {}
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  }
  async function equipItem (name, destination = 'hand') {
    const item = itemByName(name)
    if (!item) throw new Error(`no ${name} in inventory`)
    await bot.equip(item, destination)
    return item
  }
  function assertCanPlace (itemName) {
    if (cfg.safety.forbiddenPlaceBlocks.some(f => itemName.includes(f))) throw new Error(`placing ${itemName} is forbidden by safety rules`)
  }
  function assertCanDig (block) {
    if (!block) throw new Error('no block')
    if (cfg.safety.forbiddenDigBlocks.includes(block.name)) throw new Error(`digging ${block.name} is forbidden by safety rules`)
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'water' || block.name === 'lava') throw new Error(`cannot dig ${block.name}`)
  }
  async function digAt (pos, signal) {
    const block = bot.blockAt(pos)
    assertCanDig(block)
    throwIfAborted(signal)
    if (bot.entity.position.distanceTo(pos) > 4.5) await gotoNear(pos, 3, signal)
    await bot.tool.equipForBlock(block, { requireHarvest: false })
    await bot.dig(block, true)
    return block.name
  }
  const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  async function placeBlockAt (itemName, pos, signal) {
    assertCanPlace(itemName)
    const target = bot.blockAt(pos)
    if (target && target.name !== 'air' && target.name !== 'cave_air' && target.name !== 'water' && !target.name.includes('grass') && target.name !== 'snow') throw new Error(`position ${fmt(pos)} is occupied by ${target.name}`)
    let ref = null; let face = null
    for (const f of FACES) {
      const b = bot.blockAt(pos.plus(f))
      if (b && b.boundingBox === 'block') { ref = b; face = f.scaled(-1); break }
    }
    if (!ref) throw new Error(`no adjacent solid block to place against at ${fmt(pos)}`)
    if (bot.entity.position.distanceTo(pos) > 4) await gotoNear(pos, 3, signal)
    const feet = bot.entity.position.floored()
    if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) {
      await gotoNear(pos.offset(2, 0, 0), 1, signal)
    }
    await equipItem(itemName, 'hand')
    throwIfAborted(signal)
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
    await bot.placeBlock(ref, face)
  }
  async function craft (itemName, count = 1, signal) {
    const item = mcData.itemsByName[itemName]
    if (!item) throw new Error(`unknown item ${itemName}`)
    let table = null
    let recipes = bot.recipesFor(item.id, null, 1, null)
    if (!recipes.length) {
      table = findBlock('crafting_table', 24)
      if (!table) {
        const withTable = bot.recipesAll(item.id, null, true)
        if (!withTable.length) throw new Error(`no recipe for ${itemName} (missing ingredients?)`)
        if (countItem('crafting_table') === 0) {
          if (countItem('oak_planks') + countItem('spruce_planks') + countItem('birch_planks') < 4) throw new Error('need a crafting_table (and no planks to make one)')
          const tbl = mcData.itemsByName.crafting_table
          const r = bot.recipesFor(tbl.id, null, 1, null)[0]
          if (!r) throw new Error('cannot craft crafting_table')
          await bot.craft(r, 1, null)
        }
        const spot = bot.entity.position.floored().offset(1, 0, 1)
        await placeBlockAt('crafting_table', spot, signal)
        table = bot.blockAt(spot)
      }
      await gotoNear(table.position, 2, signal)
      recipes = bot.recipesFor(item.id, null, 1, table)
      if (!recipes.length) throw new Error(`no recipe available for ${itemName} — missing ingredients`)
    }
    const recipe = recipes[0]
    const per = recipe.result.count || 1
    const times = Math.ceil(count / per)
    throwIfAborted(signal)
    await bot.craft(recipe, times, table)
    return `crafted ${times * per} ${itemName}`
  }
  function nearestEntity (filter, maxDistance = 16) {
    return bot.nearestEntity(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= maxDistance && filter(e))
  }
  function playerEntity (name) {
    const p = bot.players[name]
    return p?.entity ?? null
  }
  function inventoryFillRatio () {
    const total = 36
    return 1 - (bot.inventory.emptySlotCount?.() ?? (total - bot.inventory.items().length)) / total
  }
  return {
    Vec3, goals, Movements, mcData,
    sleep: (ms) => sleep(ms),
    fmt, itemByName, countItem, findBlocks, findBlock, gotoNear, followEntity, stop, equipItem,
    assertCanPlace, assertCanDig, digAt, placeBlockAt, craft, nearestEntity, playerEntity, inventoryFillRatio
  }
}

export function fmt (p) { return p ? `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` : '?' }
