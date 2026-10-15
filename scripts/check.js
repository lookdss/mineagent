// Синтаксическая проверка всех исходников + загрузка модулей без подключения к серверу.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/config.js'

function walk (dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

let failed = 0
for (const f of [...walk('src'), ...walk('scripts')]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); console.log('ok   ', f) } catch (e) { failed++; console.log('FAIL ', f, '\n', e.stderr.toString()) }
}
const cfg = loadConfig(process.env.MINEAGENT_CONFIG ?? 'config.example.json')
console.log('config ok:', cfg.llm.baseUrl, cfg.llm.mode)
const { staticCheck } = await import('../src/skills/library/sandbox.js')
const bad = staticCheck('async function x(bot){ require("fs"); return 1 }')
if (!bad.length) { failed++; console.log('FAIL  staticCheck did not flag require()') } else console.log('ok    staticCheck flags require()')
const { builtinSkills } = await import('../src/skills/builtin/index.js')
const { SkillRegistry } = await import('../src/skills/registry.js')
const reg = new SkillRegistry()
reg.registerAll(builtinSkills({ bot: {}, h: {}, cfg, memory: {}, tasks: {}, log: console }))
console.log('builtin skills:', reg.list().length, 'tools schema ok:', reg.toTools().length)
process.exit(failed ? 1 : 0)
