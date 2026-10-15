import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import cb from 'mineflayer-collectblock'
import tp from 'mineflayer-tool'
import pvpPkg from 'mineflayer-pvp'
import { loader as autoEat } from 'mineflayer-auto-eat'

const { pathfinder, Movements } = pf

export function createBot (cfg, log) {
  const mc = cfg.minecraft
  const bot = mineflayer.createBot({
    host: mc.host,
    port: mc.port,
    username: mc.username,
    auth: mc.auth,
    version: mc.version || undefined,
    hideErrors: true
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(cb.plugin)
  bot.loadPlugin(tp.plugin)
  bot.loadPlugin(pvpPkg.plugin)
  bot.loadPlugin(autoEat)

  bot.once('spawn', () => {
    const movements = new Movements(bot)
    movements.canDig = true
    movements.allow1by1towers = true
    movements.allowParkour = true
    movements.scafoldingBlocks = movements.scafoldingBlocks.filter(id => {
      const n = bot.registry.blocks[id]?.name
      return n && !cfg.safety.forbiddenPlaceBlocks.includes(n)
    })
    bot.pathfinder.setMovements(movements)
    bot.autoEat.setOpts({ minHunger: cfg.autonomy.eatBelowFood, minHealth: 14, priority: 'foodPoints', bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'] })
    if (cfg.autonomy.enabled) bot.autoEat.enableAuto()
    log.info({ version: bot.version, pos: bot.entity.position.floored() }, 'spawned')
  })
  bot.on('kicked', r => log.warn({ reason: typeof r === 'string' ? r : JSON.stringify(r) }, 'kicked'))
  bot.on('error', e => log.error({ err: e.message }, 'bot error'))
  bot.on('death', () => log.warn('died'))
  return bot
}
