#!/usr/bin/env node
// 参考发布脚本（ADR-0015 exec adapter）——按 docs/02-spec/memory-hub-api-v1.md
// 把 memhub 批准的条目发布到你们的记忆库服务。
//
// memhub 调用方式：stdin 收到 { entries: [...], publishedAt }，退出码 0 = 成功。
// 配置（hub.yaml）：publish.adapter: exec + publish.script: push-to-hub.mjs
// 环境变量：MEMORY_HUB_URL（必填）、MEMORY_HUB_TOKEN（服务端开启鉴权时必填）。
//
// 用法：把它放进 hub 根目录即可。API 细节变化时只改这个文件。

import { readFileSync } from 'node:fs'

const base = process.env.MEMORY_HUB_URL
if (!base) {
  console.error('MEMORY_HUB_URL is not set (e.g. https://memory.internal)')
  process.exit(1)
}
const token = process.env.MEMORY_HUB_TOKEN
const input = JSON.parse(readFileSync(0, 'utf8'))
const entries = Array.isArray(input.entries) ? input.entries : []
if (entries.length === 0) {
  console.log('delivered 0')
  process.exit(0)
}

const headers = { 'content-type': 'application/json' }
if (token) headers.authorization = `Bearer ${token}`

const response = await fetch(`${base.replace(/\/$/, '')}/v1/entries`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ entries, publishedAt: input.publishedAt ?? new Date().toISOString() }),
  signal: AbortSignal.timeout(30000),
})
const text = await response.text().catch(() => '')
if (!response.ok) {
  console.error(`memory hub rejected: HTTP ${response.status} ${text.slice(0, 200)}`)
  process.exit(1)
}
let result = {}
try {
  result = JSON.parse(text || '{}')
} catch {
  // Non-JSON success body: treat as fully accepted.
}
const rejected = Array.isArray(result.rejected) ? result.rejected : []
const accepted = typeof result.accepted === 'number' ? result.accepted : entries.length
console.log(`delivered ${entries.length} (accepted ${accepted}${rejected.length > 0 ? `, rejected: ${rejected.map((r) => r.id).join(',')}` : ''})`)
