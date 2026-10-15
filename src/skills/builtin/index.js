import movement from './movement.js'
import mining from './mining.js'
import inventory from './inventory.js'
import crafting from './crafting.js'
import chat from './chat.js'
import forestry from './forestry.js'
import farming from './farming.js'
import combat from './combat.js'
import building from './building.js'

export function builtinSkills (ctx) {
  return [movement, mining, inventory, crafting, chat, forestry, farming, combat, building].flatMap(f => f(ctx))
}
