/**
 * 不依赖 DSH 运行时的冒烟测试：
 *   1. Host 半 —— 用假的 ctx 走一遍 list/save/use/delete 全链路，落到临时目录
 *   2. Client 半 —— 用假的 window.__ModuleLoader__ 捕获 factory，检查导出形状
 *
 * 跑法：node smoke.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { readFileSync } from 'node:fs'

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}

// ── Host 半 ──────────────────────────────────────────────────────────────
const dataDir = await mkdtemp(join(tmpdir(), 'prompt-deck-'))
const routes = new Map()

const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(services, callback) {
    const connection = {
      fetch: {
        register(options) {
          routes.set(`${options.methods[0]} ${options.path}`, options)
          return () => {}
        },
      },
    }
    callback({ connection, effect: this.effect })
  },
}

console.log('Host 半')
const host = await import('./index.js')
check('导出 apply', typeof host.apply === 'function')
host.apply(ctx, { dataDir })
check('注册了 4 条路由', routes.size === 4, `实际 ${routes.size}`)

async function call(method, path, body) {
  const entry = routes.get(`${method} ${path}`)
  if (!entry) throw new Error(`没有这条路由: ${path}`)
  const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
  const response = await entry.fetch(new Request(`http://local${path}`, init))
  const payload = await response.json()
  return { status: response.status, payload }
}

try {
  const empty = await call('GET', '/api/prompt-deck/list')
  check('初始为空列表', empty.status === 200 && Array.isArray(empty.payload.items) && empty.payload.items.length === 0)

  const saved = await call('POST', '/api/prompt-deck/save', {
    title: '代码审查',
    body: '请审查这段代码，重点看 {{关注点}} 和边界条件。',
    group: 'code',
  })
  check('保存成功', saved.status === 200 && Boolean(saved.payload.item?.id), JSON.stringify(saved.payload))
  const id = saved.payload.item?.id
  check('自动识别变量', JSON.stringify(saved.payload.item?.vars) === '["关注点"]', JSON.stringify(saved.payload.item?.vars))

  const used = await call('POST', '/api/prompt-deck/use', { id })
  check('记使用次数', used.payload.item?.uses === 1, JSON.stringify(used.payload.item?.uses))

  const edited = await call('POST', '/api/prompt-deck/save', { id, title: '代码审查 v2', body: '改过的内容', group: 'code' })
  check('按 id 更新而不是新增', edited.payload.items.length === 1, `列表长度 ${edited.payload.items.length}`)
  check('更新保留使用次数', edited.payload.item?.uses === 1, JSON.stringify(edited.payload.item?.uses))

  const onDisk = JSON.parse(await readFile(join(dataDir, 'snippets.json'), 'utf8'))
  check('落盘内容正确', onDisk.length === 1 && onDisk[0].title === '代码审查 v2')

  const bad = await call('POST', '/api/prompt-deck/save', { title: '只有标题', body: '' })
  check('空内容被拒绝', bad.status === 422, `${bad.status} ${JSON.stringify(bad.payload)}`)

  const removed = await call('POST', '/api/prompt-deck/delete', { id })
  check('删除成功', removed.payload.items.length === 0)
} finally {
  await rm(dataDir, { recursive: true, force: true })
}

// ── Client 半 ────────────────────────────────────────────────────────────
console.log('Client 半')
let captured = null
const stubReact = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}
const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  document: {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
  },
  fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Promise,
  Set,
  Map,
  Error,
  RegExp,
  setTimeout,
  clearTimeout,
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(readFileSync('./client.js', 'utf8'), sandbox)

check('捕获到 load 调用', captured !== null)
check(
  'id 等于包名',
  captured?.id === JSON.parse(readFileSync('./package.json', 'utf8')).name,
  captured?.id,
)
check('factory 是函数', typeof captured?.factory === 'function')

let moduleExports = null
try {
  moduleExports = captured.factory((request) => {
    if (request === 'react') return stubReact
    throw new Error(`不该 require 的东西: ${request}`)
  })
} catch (error) {
  check('factory 执行', false, error.message)
}
check('导出 apply', typeof moduleExports?.apply === 'function')
check('导出 inject 数组', Array.isArray(moduleExports?.inject), JSON.stringify(moduleExports?.inject))
check('inject 声明了 slots', moduleExports?.inject?.includes('slots'))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)