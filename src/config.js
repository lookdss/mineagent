import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const Schema = z.object({
  minecraft: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(25565),
    username: z.string().default('Bob'),
    auth: z.enum(['offline', 'microsoft']).default('offline'),
    version: z.union([z.string(), z.literal(false)]).default(false)
  }),
  bot: z.object({
    triggerNames: z.array(z.string()).default(['Bob']),
    language: z.string().default('ru'),
    ownerPlayers: z.array(z.string()).default([]),
    chatMaxLength: z.number().default(240),
    quickTaskTimeoutMs: z.number().default(8000),
    cancelTaskOnNewCommand: z.boolean().default(true)
  }).default({}),
  llm: z.object({
    baseUrl: z.string().default('http://localhost:1234/v1'),
    apiKey: z.string().default('lm-studio'),
    mode: z.enum(['single', 'dual']).default('single'),
    models: z.object({ chat: z.string(), coder: z.string().optional() }),
    temperature: z.number().default(0.3),
    maxTokens: z.number().default(1024),
    requestTimeoutMs: z.number().default(120000),
    historyTurns: z.number().default(12),
    maxToolRounds: z.number().default(4),
    maxToolsPerRequest: z.number().int().default(0),
    routerFallback: z.boolean().default(true)
  }),
  embeddings: z.object({
    model: z.string().optional(),
    fallbackToLocal: z.boolean().default(true)
  }).default({}),
  skillLibrary: z.object({
    dir: z.string().default('./data/skills'),
    learnedCodeDir: z.string().default('./data/learned'),
    minSimilarity: z.number().default(0.68),
    maxFixIterations: z.number().default(4),
    sandboxTimeoutMs: z.number().default(30000)
  }).default({}),
  autonomy: z.object({
    enabled: z.boolean().default(true),
    tickMs: z.number().default(5000),
    eatBelowFood: z.number().default(14),
    fleeBelowHealth: z.number().default(8),
    fightHostilesWithin: z.number().default(6),
    depositWhenInventoryAbove: z.number().default(0.8),
    travelKit: z.array(z.string()).default([]),
    idleThinkEveryMs: z.number().default(0)
  }).default({}),
  safety: z.object({
    forbiddenPlaceBlocks: z.array(z.string()).default([]),
    forbiddenDigBlocks: z.array(z.string()).default([]),
    maxTerrainVariance: z.number().default(3)
  }).default({}),
  logging: z.object({ level: z.string().default('info') }).default({})
})

export function loadConfig (file = process.env.MINEAGENT_CONFIG || 'config.json') {
  const p = path.resolve(file)
  const src = fs.existsSync(p) ? p : path.resolve('config.example.json')
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'))
  const cfg = Schema.parse(raw)
  cfg._file = src
  return cfg
}
