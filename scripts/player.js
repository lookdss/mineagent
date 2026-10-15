// Test "human" player: joins the server, sends chat lines from argv (separated by ';'), prints all chat.
import mineflayer from 'mineflayer'
const [,, host = '127.0.0.1', port = '25565', name = 'Steve', script = ''] = process.argv
const bot = mineflayer.createBot({ host, port: +port, username: name, auth: 'offline', hideErrors: true })
bot.on('chat', (u, m) => console.log(`[chat] <${u}> ${m}`))
bot.on('message', (jm, pos) => { if (pos === 'system') console.log('[sys]', jm.toString()) })
bot.once('spawn', async () => {
  console.log(`[${name}] spawned at`, bot.entity.position.floored())
  const lines = script.split(';').map(s => s.trim()).filter(Boolean)
  for (const line of lines) {
    const m = line.match(/^wait (\d+)$/)
    if (m) { await new Promise(r => setTimeout(r, +m[1] * 1000)); continue }
    bot.chat(line); console.log(`[${name}] > ${line}`)
    await new Promise(r => setTimeout(r, 1500))
  }
})
process.stdin.on('data', d => { const s = d.toString().trim(); if (s) bot.chat(s) })
