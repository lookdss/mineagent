import pino from 'pino'

/** Pretty logs for the terminal; raw JSON lines when the GUI (or another parent process) consumes them. */
export function createLogger (level = 'info', { json = process.env.MINEAGENT_JSON_LOGS === '1' } = {}) {
  if (json) return pino({ level, base: null, timestamp: pino.stdTimeFunctions.isoTime })
  return pino({
    level,
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
  })
}
