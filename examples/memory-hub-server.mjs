#!/usr/bin/env node
// 记忆库服务 — 参考实现（docs/02-spec/memory-hub-api-v1.md）
// 单文件、零依赖（node:http + JSON 文件存储）。任何能跑 node 的机器
// （腾讯云 CVM / 容器 / SCF 自定义运行时）即刻可用；生产可平滑替换
// 存储层为数据库，端点契约不变。
//
// 运行：MEMORY_HUB_TOKEN=xxx node memory-hub-server.mjs
//   env PORT=7800（默认）、DATA_DIR=./data（默认）

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 7800)
const TOKEN = process.env.MEMORY_HUB_TOKEN ?? ''
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data')
const STORE = join(DATA_DIR, 'entries.json')

// id → { entry: Entry, publishedAt: string }
let db = {}
if (existsSync(STORE)) {
  try { db = JSON.parse(readFileSync(STORE, 'utf8')) } catch { db = {} }
}
let saveTimer = null
function persist() {
  // Coalesce bursts; a crash loses at most 1s of publishes (retry-safe by design).
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STORE, JSON.stringify(db))
  }, 300)
}

function authorized(req) {
  if (TOKEN === '') return true
  return req.headers['authorization'] === `Bearer ${TOKEN}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function validEntry(e) {
  return typeof e?.id === 'string' && e.id !== ''
    && typeof e?.version === 'number' && Number.isFinite(e.version)
    && typeof e?.title === 'string'
    && typeof e?.body === 'string'
}

/** Spec upsert: higher version → replace, equal → no-op, lower → stale rejection. */
function upsert(entry, publishedAt) {
  const existing = db[entry.id]
  if (existing === undefined || entry.version > existing.entry.version) {
    db[entry.id] = { entry, publishedAt }
    return 'accepted'
  }
  if (entry.version === existing.entry.version) return 'accepted' // idempotent no-op
  return 'stale version'
}

function searchScore(entry, terms) {
  if (terms.length === 0) return 0
  const title = entry.title.toLowerCase()
  const summary = entry.summary.toLowerCase()
  const tags = entry.tags.join(' ').toLowerCase()
  const body = entry.body.toLowerCase()
  let score = 0
  for (const t of terms) {
    if (title.includes(t)) score += 3
    if (tags.includes(t)) score += 2
    if (summary.includes(t)) score += 2
    if (body.includes(t)) score += 1
  }
  return score
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const unauthorized = () => send(401, { error: 'unauthorized' })

  try {
    if (url.pathname === '/v1/health') return send(200, { ok: true, count: Object.keys(db).length })

    if (url.pathname === '/v1/entries' && req.method === 'POST') {
      if (!authorized(req)) return unauthorized()
      const payload = JSON.parse((await readBody(req)) || '{}')
      const entries = Array.isArray(payload.entries) ? payload.entries : []
      if (entries.length === 0) return send(400, { error: 'entries array required' })
      const publishedAt = typeof payload.publishedAt === 'string' ? payload.publishedAt : new Date().toISOString()
      let accepted = 0
      const rejected = []
      for (const entry of entries) {
        if (!validEntry(entry)) {
          rejected.push({ id: String(entry?.id ?? '?'), reason: 'invalid entry' })
          continue
        }
        if (upsert(entry, publishedAt) === 'accepted') accepted += 1
        else rejected.push({ id: entry.id, reason: 'stale version' })
      }
      persist()
      return send(200, { accepted, rejected })
    }

    if (url.pathname === '/v1/entries' && req.method === 'GET') {
      const since = url.searchParams.get('since') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? 500)
      const all = Object.values(db)
        .map((r) => r.entry)
        .filter((e) => since === '' || (e.updated ?? '') > since)
        .sort((a, b) => (a.updated ?? '').localeCompare(b.updated ?? ''))
        .slice(0, limit)
        .map(({ body, ...meta }) => meta) // metadata only — body via /:id
      return send(200, { entries: all, since, count: all.length })
    }

    const detail = /^\/v1\/entries\/([^/]+)$/.exec(url.pathname)
    if (detail !== null && req.method === 'GET') {
      const id = decodeURIComponent(detail[1])
      const record = db[id]
      if (record === undefined) return send(404, { error: 'not found' })
      const { body, ...frontmatter } = record.entry
      return send(200, { frontmatter, body })
    }

    if (url.pathname === '/v1/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? 5)
      const terms = q.toLowerCase().split(/\s+/).filter((t) => t !== '')
      const results = Object.values(db)
        .map((r) => ({ entry: r.entry, score: searchScore(r.entry, terms) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      const max = results.length > 0 ? results[0].score : 1
      return send(200, {
        results: results.map((r) => ({
          id: r.entry.id,
          version: r.entry.version,
          title: r.entry.title,
          summary: r.entry.summary,
          score: max > 0 ? Math.round((r.score / max) * 100) / 100 : 0,
          body: r.entry.body,
        })),
      })
    }

    return send(404, { error: 'not found' })
  } catch (error) {
    return send(500, { error: 'internal', detail: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(PORT, () => {
  console.log(`memory-hub reference server: http://127.0.0.1:${PORT} (data: ${DATA_DIR}, auth: ${TOKEN === '' ? 'OFF' : 'Bearer on'})`)
})
