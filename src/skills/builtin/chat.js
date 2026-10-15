import { z } from 'zod'

export default function chatSkills (ctx) {
  return [
    {
      name: 'say',
      description: 'Сказать что-то в чат (только когда нужно сообщить игроку результат или ответить словами).',
      params: z.object({ text: z.string().max(500) }),
      async run (args) {
        ctx.say(args.text)
        return '(сказано)'
      }
    }
  ]
}
