const { app, BrowserWindow, ipcMain, utilityProcess, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const APP_ROOT = app.getAppPath()
const USER_DIR = app.getPath('userData')
const CONFIG_PATH = path.join(USER_DIR, 'config.json')
const DATA_DIR = path.join(USER_DIR, 'data')
const EXAMPLE_PATH = path.join(APP_ROOT, 'config.example.json')

let win = null
let runtime = null
let runtimeState = 'stopped'

function readJson (p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }

function loadConfig () {
  const base = readJson(EXAMPLE_PATH)
  if (!fs.existsSync(CONFIG_PATH)) return { config: base, fresh: true }
  try { return { config: readJson(CONFIG_PATH), fresh: false } } catch { return { config: base, fresh: true } }
}

function saveConfig (cfg) {
  fs.mkdirSync(USER_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function send (channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload) }
function setState (state, extra = {}) { runtimeState = state; send('bot:state', { state, ...extra }) }

function startRuntime () {
  if (runtime) return { ok: false, error: 'Бот уже запущен' }
  if (!fs.existsSync(CONFIG_PATH)) return { ok: false, error: 'Сначала сохраните настройки' }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const entry = path.join(APP_ROOT, 'src', 'index.js')
  runtime = utilityProcess.fork(entry, [], {
    cwd: USER_DIR,
    stdio: 'pipe',
    serviceName: 'mineagent-runtime',
    env: { ...process.env, MINEAGENT_CONFIG: CONFIG_PATH, MINEAGENT_JSON_LOGS: '1' }
  })
  setState('starting')

  const feed = (stream, level) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const o = JSON.parse(line)
          send('bot:log', { time: o.time, level: levelName(o.level), msg: o.msg, data: stripMeta(o) })
        } catch { send('bot:log', { time: new Date().toISOString(), level, msg: line, data: {} }) }
      }
    })
  }
  feed(runtime.stdout, 'info')
  feed(runtime.stderr, 'error')

  runtime.on('message', (m) => {
    if (!m || typeof m !== 'object') return
    if (m.type === 'state') setState(m.state, m)
    else if (m.type === 'ready') send('bot:ready', m)
    else if (m.type === 'status') send('bot:status', m)
    else if (m.type === 'chat') send('bot:chat', m)
  })
  runtime.on('exit', (code) => {
    runtime = null
    setState('stopped', { code })
    send('bot:log', { time: new Date().toISOString(), level: code ? 'error' : 'info', msg: `Процесс бота завершён (код ${code})`, data: {} })
  })
  return { ok: true }
}

function stopRuntime () {
  if (!runtime) return { ok: true }
  const p = runtime
  setState('stopping')
  try { p.postMessage({ type: 'shutdown' }) } catch {}
  setTimeout(() => { try { p.kill() } catch {} }, 3000)
  return { ok: true }
}

const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
function levelName (l) { return typeof l === 'number' ? (LEVELS[l] || 'info') : String(l || 'info') }
function stripMeta (o) { const { level, time, msg, pid, hostname, ...rest } = o; return rest }

async function listModels (baseUrl, apiKey) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/models'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey || 'lm-studio'}` }, signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean)
    return { ok: true, models: ids }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'нет ответа (таймаут)' : e.message }
  } finally { clearTimeout(t) }
}

function createWindow () {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 860, minHeight: 600,
    title: 'MineAgent',
    backgroundColor: '#15181e',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

ipcMain.handle('config:get', () => ({ ...loadConfig(), paths: { config: CONFIG_PATH, data: DATA_DIR, userDir: USER_DIR } }))
ipcMain.handle('config:save', (_e, cfg) => { try { saveConfig(cfg); return { ok: true } } catch (e) { return { ok: false, error: e.message } } })
ipcMain.handle('config:reset', () => ({ config: readJson(EXAMPLE_PATH) }))
ipcMain.handle('llm:models', (_e, { baseUrl, apiKey }) => listModels(baseUrl, apiKey))
ipcMain.handle('bot:start', () => startRuntime())
ipcMain.handle('bot:stop', () => stopRuntime())
ipcMain.handle('bot:state', () => ({ state: runtimeState }))
ipcMain.handle('bot:send', (_e, msg) => { if (!runtime) return { ok: false, error: 'Бот не запущен' }; runtime.postMessage({ type: 'chat', ...msg }); return { ok: true } })
ipcMain.handle('app:openDataDir', () => { fs.mkdirSync(DATA_DIR, { recursive: true }); return shell.openPath(USER_DIR) })
ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { stopRuntime(); app.quit() })
app.on('before-quit', () => { if (runtime) { try { runtime.kill() } catch {} } })
process.on('uncaughtException', (e) => { try { dialog.showErrorBox('MineAgent', e.stack || e.message) } catch {} })
