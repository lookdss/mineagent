// E2E-тест: подключается тестовым игроком, шлёт прямые команды боту и проверяет ответы.
// Требует запущенный сервер и запущенный MineAgent (npm start).
//   node scripts/e2e.js [host] [port] [botName]
import mineflayer from 'mineflayer'
const [,, host = '127.0.0.1', port = '25565', botName = 'Bob'] = process.argv
const player = mineflayer.createBot({ host, port: +port, username: 'Tester', auth: 'offline', hideErrors: true })

const steps = [
  { cmd: '!get_status', expect: /HP \d+/ },
  { cmd: '!come_here', expect: /Пришёл|Иду/ , timeout: 40000 },
  { cmd: '!list_inventory', expect: /x\d+|пуст/ },
  { cmd: '!collect_block block=dirt count=1', expect: /Собрал|не вижу/, timeout: 60000 },
  { cmd: '!craft_item item=stick count=4', expect: /Скрафтил|не хватает|Не получилось/, timeout: 30000 },
  { cmd: '!list_learned_skills', expect: /навык|выучил/ },
  { cmd: '!stop', expect: /Остановился|ничего не делаю/ }
]

const waitFor = (re, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { player.off('chat', h); reject(new Error(`timeout waiting for ${re}`)) }, ms)
  function h (u, m) { if (u === botName && re.test(m)) { clearTimeout(t); player.off('chat', h); resolve(m) } }
  player.on('chat', h)
})

player.on('chat', (u, m) => console.log(`  <${u}> ${m}`))
player.once('spawn', async () => {
  await new Promise(r => setTimeout(r, 2000))
  let failed = 0
  for (const s of steps) {
    const line = `${botName}, ${s.cmd}`
    console.log(`\n> ${line}`)
    const p = waitFor(s.expect, s.timeout ?? 15000)
    player.chat(line)
    try { await p; console.log('  PASS') } catch (e) { failed++; console.log('  FAIL:', e.message) }
  }
  console.log(`\n${steps.length - failed}/${steps.length} passed`)
  player.quit(); process.exit(failed ? 1 : 0)
})
player.on('kicked', r => { console.error('kicked:', r); process.exit(2) })
player.on('error', e => { console.error('error:', e.message); process.exit(2) })
