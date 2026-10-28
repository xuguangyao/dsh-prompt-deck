/**
 * 提示词牌组 —— Host 半（跑在 DSH 的 Node 进程里）
 *
 * 职责只有两件：
 *   1. 把提示词片段持久化到一个 JSON 文件（跨会话、跨重启都在）
 *   2. 开几个 HTTP 接口，让浏览器里的 Client 半能读写
 *
 * 刻意不依赖任何第三方包，也不往会话日志里写东西 —— 这是纯插件私有数据。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_BASE = '/api/prompt-deck'
const MAX_ITEMS = 200
const MAX_TITLE = 120
const MAX_BODY = 12000
const MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_GROUP = 'my'
/** 允许的分组 id。Client 的半固定四类 + 一个兜底，Host 只做白名单校验。 */
const GROUPS = new Set(['code', 'write', 'analysis', 'my', 'other'])

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function clamp(text, limit) {
  const value = asString(text).trim()
  return value.length > limit ? value.slice(0, limit) : value
}

/** 抽出 {{变量}} 形式的占位符名，去重保序。 */
function extractVars(body) {
  const found = []
  const seen = new Set()
  for (const match of String(body ?? '').matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g)) {
    const name = match[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    found.push(name)
  }
  return found
}

function newId() {
  return `snp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function createStore(ctx, config) {
  const root = asString(config?.dataDir).trim() || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'prompt-deck')
  const file = join(root, 'snippets.json')

  /** 内存里的一份缓存；null 表示还没读过磁盘。 */
  let items = null
  /** 写操作串行化，避免两个请求同时读-改-写把数据冲掉。 */
  let queue = Promise.resolve()

  function enqueue(task) {
    const run = queue.then(() => task())
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null
    const title = clamp(raw.title, MAX_TITLE)
    const body = clamp(raw.body, MAX_BODY)
    if (!title && !body) return null
    const group = GROUPS.has(asString(raw.group)) ? asString(raw.group) : DEFAULT_GROUP
    const uses = Number.isFinite(raw.uses) ? Math.max(0, Math.floor(raw.uses)) : 0
    return {
      id: asString(raw.id) || newId(),
      title: title || '未命名',
      body,
      group,
      vars: extractVars(body),
      uses,
      lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : 0,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    }
  }

  async function readDisk() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
      return list.map(sanitize).filter(Boolean).slice(0, MAX_ITEMS)
    } catch {
      // 文件被手工改坏了：留个备份再从空列表开始，不要因此让插件起不来。
      ctx.logger?.warn?.(`prompt-deck: ${file} 不是合法 JSON，已备份为 .bak`)
      await rename(file, `${file}.bak`).catch(() => {})
      return []
    }
  }

  async function writeDisk(next) {
    await mkdir(root, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
    await rename(temp, file)
  }

  async function ensure() {
    if (items !== null) return items
    items = await readDisk()
    return items
  }

  return {
    file,
    async list() {
      return enqueue(async () => {
        const current = await ensure()
        return current
      })
    },
    async save(raw) {
      return enqueue(async () => {
        const current = await ensure()
        const incomingId = asString(raw?.id)
        const existing = incomingId ? current.find((item) => item.id === incomingId) : null
        const record = sanitize({
          ...raw,
          id: existing?.id ?? incomingId,
          uses: existing?.uses ?? raw?.uses,
          lastUsedAt: existing?.lastUsedAt ?? raw?.lastUsedAt,
          createdAt: existing?.createdAt ?? raw?.createdAt,
        })
        if (!record) throw new HttpError(422, 'PROMPT_DECK_EMPTY', '标题和内容不能都为空')
        if (!clamp(raw?.body, MAX_BODY)) throw new HttpError(422, 'PROMPT_DECK_NO_BODY', '提示词内容不能为空')

        const next = existing
          ? current.map((item) => (item.id === existing.id ? { ...record, id: existing.id } : item))
          : [record, ...current]
        const trimmed = next.slice(0, MAX_ITEMS)
        await writeDisk(trimmed)
        items = trimmed
        return { record, items: trimmed }
      })
    },
    async remove(id) {
      return enqueue(async () => {
        const current = await ensure()
        const next = current.filter((item) => item.id !== id)
        if (next.length === current.length) throw new HttpError(404, 'PROMPT_DECK_NOT_FOUND', '找不到这条提示词')
        await writeDisk(next)
        items = next
        return next
      })
    },
    async markUsed(id) {
      return enqueue(async () => {
        const current = await ensure()
        const index = current.findIndex((item) => item.id === id)
        if (index < 0) throw new HttpError(404, 'PROMPT_DECK_NOT_FOUND', '找不到这条提示词')
        const updated = { ...current[index], uses: current[index].uses + 1, lastUsedAt: Date.now() }
        const next = current.map((item, i) => (i === index ? updated : item))
        await writeDisk(next)
        items = next
        return { item: updated, items: next }
      })
    },
    stop() {
      items = null
    },
  }
}

async function readJson(request) {
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'PROMPT_DECK_TOO_LARGE', '请求体过大')
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new HttpError(400, 'PROMPT_DECK_BAD_JSON', '请求体不是 JSON 对象')
  }
}

export function apply(ctx, config = {}) {
  const store = createStore(ctx, config)

  const routes = [
    [`${ROUTE_BASE}/list`, 'GET', async () => json({ items: await store.list() })],
    [
      `${ROUTE_BASE}/save`,
      'POST',
      async (request) => {
        const result = await store.save(await readJson(request))
        return json({ item: result.record, items: result.items })
      },
    ],
    [
      `${ROUTE_BASE}/delete`,
      'POST',
      async (request) => {
        const body = await readJson(request)
        if (!asString(body.id)) throw new HttpError(422, 'PROMPT_DECK_NO_ID', '缺少 id')
        return json({ items: await store.remove(body.id) })
      },
    ],
    [
      `${ROUTE_BASE}/use`,
      'POST',
      async (request) => {
        const body = await readJson(request)
        if (!asString(body.id)) throw new HttpError(422, 'PROMPT_DECK_NO_ID', '缺少 id')
        const result = await store.markUsed(body.id)
        return json({ item: result.item, items: result.items })
      },
    ],
  ]

  ctx.inject(['connection'], (connectionCtx) => {
    for (const [routePath, method, handler] of routes) {
      const dispose = connectionCtx.connection.fetch.register({
        path: routePath,
        methods: [method],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (error) {
            if (error instanceof HttpError) {
              return json({ error: { code: error.code, message: error.message } }, error.status)
            }
            ctx.logger?.warn?.(`prompt-deck: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
            return json(
              { error: { code: 'PROMPT_DECK_ERROR', message: error instanceof Error ? error.message : String(error) } },
              500,
            )
          }
        },
      })
      connectionCtx.effect(() => dispose)
    }
  })

  ctx.effect(() => () => store.stop())
  ctx.logger?.info?.(`prompt-deck: 数据文件 ${store.file}`)
}