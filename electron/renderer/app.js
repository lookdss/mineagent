const $ = (id) => document.getElementById(id)
const STATE_TEXT = {
  stopped: 'Остановлен', starting: 'Запуск…', connecting: 'Подключение к серверу…', spawned: 'В игре', disconnected: 'Отключён', stopping: 'Остановка…'
}
let cfg = null
let paths = null
let state = 'stopped'
let logLevel = 'info'
const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

// ---------- navigation ----------
function goto (page) {
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page))
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`))
}
document.querySelectorAll('.nav').forEach(b => b.onclick = () => goto(b.dataset.page))
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); goto(a.dataset.goto) } })

// ---------- config <-> form ----------
const list = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean)
const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d }

function fillForm (c) {
  $('mc-host').value = c.minecraft.host ?? ''
  $('mc-port').value = c.minecraft.port ?? 25565
  $('mc-username').value = c.minecraft.username ?? 'Bob'
  $('mc-auth').value = c.minecraft.auth ?? 'offline'
  $('mc-version').value = c.minecraft.version || ''
  $('bot-triggers').value = (c.bot?.triggerNames || []).join(', ')
  $('bot-owners').value = (c.bot?.ownerPlayers || []).join(', ')
  $('llm-url').value = c.llm.baseUrl ?? ''
  $('llm-key').value = c.llm.apiKey ?? 'lm-studio'
  $('llm-mode').value = c.llm.mode ?? 'single'
  $('llm-chat').value = c.llm.models?.chat ?? ''
  $('llm-coder').value = c.llm.models?.coder ?? ''
  $('emb-model').value = c.embeddings?.model ?? ''
  $('llm-temp').value = c.llm.temperature ?? 0.3
  $('llm-tools').value = c.llm.maxToolsPerRequest ?? 12
  $('au-enabled').checked = c.autonomy?.enabled !== false
  $('au-eat').value = c.autonomy?.eatBelowFood ?? 14
  $('au-flee').value = c.autonomy?.fleeBelowHealth ?? 8
  $('au-fight').value = c.autonomy?.fightHostilesWithin ?? 6
  $('au-deposit').value = Math.round((c.autonomy?.depositWhenInventoryAbove ?? 0.8) * 100)
  $('log-cfg').value = c.logging?.level ?? 'info'
  updateModeUI()
}

function readForm () {
  const c = JSON.parse(JSON.stringify(cfg))
  const triggers = list($('bot-triggers').value)
  const username = $('mc-username').value.trim() || 'Bob'
  c.minecraft = { ...c.minecraft, host: $('mc-host').value.trim() || '127.0.0.1', port: Math.round(num('mc-port', 25565)), username, auth: $('mc-auth').value, version: $('mc-version').value.trim() || false }
  c.bot = { ...c.bot, triggerNames: triggers.length ? triggers : [username], ownerPlayers: list($('bot-owners').value) }
  const mode = $('llm-mode').value
  const coder = $('llm-coder').value.trim()
  c.llm = { ...c.llm, baseUrl: $('llm-url').value.trim() || 'http://localhost:1234/v1', apiKey: $('llm-key').value.trim() || 'lm-studio', mode, models: { chat: $('llm-chat').value.trim(), ...(coder ? { coder } : {}) }, temperature: num('llm-temp', 0.3), maxToolsPerRequest: Math.round(num('llm-tools', 12)) }
  const emb = $('emb-model').value.trim()
  c.embeddings = { ...c.embeddings, fallbackToLocal: true }
  if (emb) c.embeddings.model = emb; else delete c.embeddings.model
  c.autonomy = { ...c.autonomy, enabled: $('au-enabled').checked, eatBelowFood: num('au-eat', 14), fleeBelowHealth: num('au-flee', 8), fightHostilesWithin: num('au-fight', 6), depositWhenInventoryAbove: num('au-deposit', 80) / 100 }
  c.logging = { ...c.logging, level: $('log-cfg').value }
  return c
}

function validate (c) {
  if (!c.llm.models.chat) return 'Укажите модель для чата (вкладка Настройки → Нейросеть)'
  if (c.llm.mode === 'dual' && !c.llm.models.coder) return 'В режиме двух моделей укажите coder-модель'
  if (!/^https?:\/\//.test(c.llm.baseUrl)) return 'Адрес LM Studio должен начинаться с http:// или https://'
  return null
}

function updateModeUI () { $('lbl-coder').style.display = $('llm-mode').value === 'dual' ? '' : 'none' }
$('llm-mode').onchange = updateModeUI

function note (text, cls) { const n = $('save-note'); n.textContent = text; n.className = `note ${cls || ''}`; n.hidden = false; clearTimeout(note.t); note.t = setTimeout(() => { n.hidden = true }, 4000) }

async function save () {
  const c = readForm()
  const err = validate(c)
  if (err) { note(err, 'err'); goto('settings'); return false }
  const r = await window.api.saveConfig(c)
  if (!r.ok) { note(`Не удалось сохранить: ${r.error}`, 'err'); return false }
  cfg = c
  $('first-run').hidden = true
  note(state === 'stopped' ? 'Сохранено' : 'Сохранено. Изменения применятся после перезапуска бота', 'ok')
  return true
}
$('btn-save').onclick = save
$('btn-reset').onclick = async () => { const r = await window.api.resetConfig(); fillForm(r.config); note('Настройки сброшены к примеру (не забудьте сохранить)') }
$('btn-open-data').onclick = () => window.api.openDataDir()

$('btn-models').onclick = async () => {
  const st = $('models-status'); st.textContent = 'Подключаюсь…'; st.className = 'hint'
  const r = await window.api.listModels($('llm-url').value.trim(), $('llm-key').value.trim())
  if (!r.ok) { st.textContent = `LM Studio недоступен: ${r.error}. Проверьте, что сервер запущен (Developer → Start Server).`; st.className = 'hint err'; return }
  const dl = $('models'); dl.innerHTML = ''
  r.models.forEach(m => { const o = document.createElement('option'); o.value = m; dl.appendChild(o) })
  st.textContent = r.models.length ? `Найдено моделей: ${r.models.length} — ${r.models.join(', ')}` : 'Сервер отвечает, но моделей не загружено. Загрузите модель в LM Studio.'
  st.className = 'hint ok'
  if (!$('llm-chat').value && r.models.length) {
    const chat = r.models.find(m => /instruct|chat/i.test(m) && !/embed|coder/i.test(m)) || r.models.find(m => !/embed/i.test(m))
    if (chat) $('llm-chat').value = chat
    const coder = r.models.find(m => /coder|devstral|codestral/i.test(m)); if (coder && !$('llm-coder').value) $('llm-coder').value = coder
    const emb = r.models.find(m => /embed|bge|e5/i.test(m)); if (emb && !$('emb-model').value) $('emb-model').value = emb
  }
}

// ---------- bot control ----------
function setState (s, extra = {}) {
  state = s
  const pill = $('state-pill'); pill.className = `pill ${s}`
  let text = STATE_TEXT[s] || s
  if (s === 'spawned' && extra.username) text = `В игре: ${extra.username}${extra.version ? ` (${extra.version})` : ''}`
  if (s === 'connecting' && extra.host) text = `Подключение к ${extra.host}:${extra.port}…`
  $('state-text').textContent = text
  const running = s !== 'stopped'
  $('btn-start').hidden = running
  $('btn-stop').hidden = !running
  $('btn-stop').disabled = s === 'stopping'
  if (s === 'stopped' || s === 'disconnected') ['st-hp', 'st-food', 'st-pos', 'st-time', 'st-task'].forEach(id => { $(id).textContent = '—' })
}
$('btn-start').onclick = async () => {
  if (!(await save())) return
  const r = await window.api.start()
  if (!r.ok) { addChat({ from: 'MineAgent', text: r.error, system: true }); return }
  goto('bot')
}
$('btn-stop').onclick = () => window.api.stop()

window.api.onState((p) => setState(p.state, p))
window.api.onStatus((s) => {
  $('st-hp').textContent = s.self?.health != null ? `${Math.round(s.self.health)} / 20` : '—'
  $('st-food').textContent = s.self?.food != null ? `${Math.round(s.self.food)} / 20` : '—'
  const p = s.self?.position; $('st-pos').textContent = p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : '—'
  const T = { day: 'день', night: 'ночь', dusk: 'вечер', dawn: 'утро' }
  $('st-time').textContent = (T[s.environment?.time_of_day] || s.environment?.time_of_day || '—') + (s.environment?.is_raining ? ', дождь' : '')
  $('st-task').textContent = s.active_task && s.active_task !== 'None' ? s.active_task : 'нет'
})
window.api.onReady((p) => addChat({ from: 'MineAgent', text: `Бот в игре. Навыков: ${p.skills.length}.`, system: true }))

// ---------- chat ----------
function addChat ({ from, text, self, system }) {
  const el = document.createElement('div')
  el.className = `msg${self ? ' self' : ''}${system ? ' system' : ''}`
  if (!system) { const s = document.createElement('small'); s.textContent = from; el.appendChild(s) }
  el.appendChild(document.createTextNode(text))
  const box = $('chat'); box.appendChild(el); box.scrollTop = box.scrollHeight
  while (box.children.length > 300) box.removeChild(box.firstChild)
}
window.api.onChat(addChat)
$('chat-form').onsubmit = async (e) => {
  e.preventDefault()
  const text = $('chat-input').value.trim(); if (!text) return
  $('chat-input').value = ''
  const inGame = $('chat-ingame').checked
  addChat({ from: inGame ? 'вы → в игру' : 'вы', text, self: true })
  const r = await window.api.send({ text, inGame, from: cfg?.bot?.ownerPlayers?.[0] || 'Оператор' })
  if (!r.ok) addChat({ from: 'MineAgent', text: r.error, system: true })
}

// ---------- log ----------
$('log-level').onchange = () => { logLevel = $('log-level').value; document.querySelectorAll('.ln').forEach(applyLevel) }
$('log-clear').onclick = () => { $('log').innerHTML = '' }
function applyLevel (el) { el.style.display = (LEVEL_NUM[el.dataset.level] || 30) >= (LEVEL_NUM[logLevel] || 30) ? '' : 'none' }
window.api.onLog((l) => {
  const el = document.createElement('div')
  el.className = `ln ${l.level}`; el.dataset.level = l.level
  const t = l.time ? new Date(l.time).toLocaleTimeString('ru-RU') : ''
  const data = l.data && Object.keys(l.data).length ? ' ' + JSON.stringify(l.data) : ''
  el.innerHTML = `<span class="t">${t}</span> ${esc(l.msg || '')}<span class="d">${esc(data)}</span>`
  applyLevel(el)
  const box = $('log'); const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20
  box.appendChild(el); while (box.children.length > 2000) box.removeChild(box.firstChild)
  if (stick) box.scrollTop = box.scrollHeight
})
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

// ---------- init ----------
;(async () => {
  const r = await window.api.getConfig()
  cfg = r.config; paths = r.paths
  fillForm(cfg)
  $('version').textContent = `v${await window.api.version()} · ${paths.userDir}`
  const st = await window.api.getState(); setState(st.state)
  if (r.fresh) { $('first-run').hidden = false; goto('settings') }
})()
