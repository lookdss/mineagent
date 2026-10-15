import { z } from 'zod'
import { throwIfAborted, sleep } from '../../bot/taskManager.js'

export default function movementSkills (ctx) {
  const { bot, h } = ctx
  return [
    {
      name: 'come_here',
      description: 'Подойти к игроку (идти к его текущей позиции).',
      params: z.object({ player: z.string().describe('имя игрока') }),
      long: true,
      ack: a => `Иду к ${a.player}.`,
      async run (args, signal) {
        const e = h.playerEntity(args.player)
        if (!e) throw new Error(`игрок ${args.player} не виден`)
        await h.gotoNear(e.position, 2, signal)
        return `Пришёл к ${args.player}.`
      }
    },
    {
      name: 'follow_player',
      description: 'Следовать за игроком, пока не скажут остановиться.',
      params: z.object({ player: z.string(), range: z.number().min(1).max(10).default(2) }),
      long: true,
      ack: a => `Следую за ${a.player}.`,
      async run (args, signal) {
        const e = h.playerEntity(args.player)
        if (!e) throw new Error(`игрок ${args.player} не виден`)
        await h.followEntity(e, args.range)
        while (!signal.aborted) {
          await sleep(1000, signal)
          if (!h.playerEntity(args.player)) { h.stop(); return `Потерял ${args.player} из виду, остановился.` }
        }
        return 'Перестал следовать.'
      }
    },
    {
      name: 'goto_position',
      description: 'Идти к координатам x, y, z.',
      params: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }),
      long: true,
      ack: a => `Иду к (${Math.round(a.x)}, ${a.y != null ? Math.round(a.y) + ', ' : ''}${Math.round(a.z)}).`,
      async run (args, signal) {
        const y = args.y ?? bot.entity.position.y
        await h.gotoNear({ x: args.x, y, z: args.z }, 1, signal)
        return `Пришёл на ${h.fmt(bot.entity.position)}.`
      }
    },
    {
      name: 'stop',
      description: 'Остановить текущее действие/задачу.',
      params: z.object({}),
      async run () {
        const had = await ctx.tasks.cancel('stopped by player')
        h.stop()
        return had ? 'Остановился.' : 'Я и так ничего не делаю.'
      }
    },
    {
      name: 'get_status',
      description: 'Сообщить своё состояние: здоровье, еда, позиция, текущая задача.',
      params: z.object({}),
      async run () {
        throwIfAborted()
        const p = bot.entity.position
        return `HP ${bot.health}/20, еда ${bot.food}/20, позиция ${h.fmt(p)}, задача: ${ctx.tasks.describeActive()}`
      }
    }
  ]
}
