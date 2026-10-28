/**
 * 提示词牌组 —— Client 半（跑在浏览器里）
 *
 * 约定：这个文件被当作浏览器 bundle 加载，id 必须等于 package.json 的 name。
 * 模块级只注册 factory，不产生任何副作用；所有注册都放在 apply(ctx) 里。
 */
window.__ModuleLoader__.load({
  id: '@xgy/dsh-prompt-deck',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-deck'
    const MAX_CAPSULES = 6
    const GROUPS = [
      { id: 'all', label: '全部' },
      { id: 'code', label: '代码' },
      { id: 'write', label: '写作' },
      { id: 'analysis', label: '分析' },
      { id: 'my', label: '我的' },
    ]

    // ── 数据层 ────────────────────────────────────────────────────────────
    // 一个极小的模块级 store：数据只有一份，组件订阅它，写完就把新快照广播出去。
    let RUNTIME = null
    let state = { items: [], loaded: false, error: '' }
    const listeners = new Set()

    function publish(patch) {
      state = { ...state, ...patch }
      for (const listener of listeners) listener(state)
    }

    function useDeck() {
      const [snapshot, setSnapshot] = React.useState(state)
      React.useEffect(() => {
        listeners.add(setSnapshot)
        setSnapshot(state)
        return () => {
          listeners.delete(setSnapshot)
        }
      }, [])
      return snapshot
    }

    async function apiRequest(path, body) {
      const options =
        body === undefined
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(path, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const detail = payload && payload.error ? payload.error : null
        throw new Error(detail && detail.message ? detail.message : `HTTP ${response.status}`)
      }
      return payload
    }

    async function refresh() {
      try {
        const payload = await apiRequest('/api/prompt-deck/list')
        publish({ items: Array.isArray(payload?.items) ? payload.items : [], loaded: true, error: '' })
      } catch (error) {
        publish({ loaded: true, error: error instanceof Error ? error.message : String(error) })
      }
    }

    async function saveSnippet(draft) {
      const payload = await apiRequest('/api/prompt-deck/save', {
        id: draft.id || '',
        title: draft.title,
        body: draft.body,
        group: draft.group,
      })
      publish({ items: Array.isArray(payload?.items) ? payload.items : state.items, error: '' })
      return payload?.item ?? null
    }

    async function deleteSnippet(id) {
      const payload = await apiRequest('/api/prompt-deck/delete', { id })
      publish({ items: Array.isArray(payload?.items) ? payload.items : state.items, error: '' })
    }

    async function recordUse(id) {
      const payload = await apiRequest('/api/prompt-deck/use', { id })
      publish({ items: Array.isArray(payload?.items) ? payload.items : state.items, error: '' })
    }

    // ── 排序与筛选 ────────────────────────────────────────────────────────
    function score(item) {
      // 用得多的优先；用得一样多时，最近用过的优先。
      const recency = item.lastUsedAt ? Math.max(0, 1 - (Date.now() - item.lastUsedAt) / (1000 * 60 * 60 * 24 * 30)) : 0
      return item.uses * 10 + recency
    }

    function topSnippets(items, limit) {
      return [...items].sort((a, b) => score(b) - score(a)).slice(0, limit)
    }

    function matchesQuery(item, query) {
      if (!query) return true
      const needle = query.trim().toLowerCase()
      if (!needle) return true
      return `${item.title}\n${item.body}`.toLowerCase().includes(needle)
    }

    // ── 变量 ──────────────────────────────────────────────────────────────
    const VAR_PATTERN = /\{\{\s*([^{}]{1,40}?)\s*\}\}/g

    function parseVars(body) {
      const found = []
      const seen = new Set()
      for (const match of String(body ?? '').matchAll(VAR_PATTERN)) {
        const name = match[1].trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        found.push(name)
      }
      return found
    }

    function fillVars(body, values) {
      return String(body ?? '').replace(VAR_PATTERN, (whole, name) => {
        const value = values[name.trim()]
        return value && value.trim() ? value : whole
      })
    }

    // ── 把文字放进输入框 ──────────────────────────────────────────────────
    // 走的是宿主 conversation 服务：conversation.input.shell(sessionId).setDraft(...)
    // 宿主自己也在用同一条路径（例如插件市场"用这条提示词新建会话"）。
    function readDraft(shell) {
      try {
        const snapshot = shell.draftSnapshot
        if (typeof snapshot === 'string') return snapshot
        if (snapshot && typeof snapshot.draft === 'string') return snapshot.draft
      } catch {
        /* 拿不到就当作空草稿 */
      }
      try {
        const snapshot = shell.state && typeof shell.state.getSnapshot === 'function' ? shell.state.getSnapshot() : null
        if (snapshot && typeof snapshot.draft === 'string') return snapshot.draft
      } catch {
        /* 同上 */
      }
      return ''
    }

    /**
     * slot 的 `inject: (sessionId) => ...` 正常会给到 id；万一宿主换了签名，
     * 再从 sessions 服务兜一层，别让整个面板因为拿不到 id 就不显示。
     */
    function resolveSessionId(fromSlot) {
      if (fromSlot) return String(fromSlot)
      try {
        const sessions = RUNTIME && typeof RUNTIME.get === 'function' ? RUNTIME.get('sessions') : undefined
        const current = sessions && (sessions.current ?? sessions.active ?? sessions.currentSession)
        const id = typeof current === 'string' ? current : current && current.id
        if (id) return String(id)
      } catch {
        /* 拿不到就当没有 */
      }
      return ''
    }

    function insertText(sessionId, text) {
      const conversation = RUNTIME && typeof RUNTIME.get === 'function' ? RUNTIME.get('conversation') : undefined
      if (!conversation) {
        console.warn('[prompt-deck] conversation 服务不可用，无法插入')
        return false
      }
      const target = resolveSessionId(sessionId)
      if (!target) {
        console.warn('[prompt-deck] 没有拿到会话 id，无法插入')
        return false
      }
      try {
        const shell = conversation.input.shell(target)
        if (!shell || typeof shell.setDraft !== 'function') {
          console.warn('[prompt-deck] 输入框句柄不可用')
          return false
        }
        const current = readDraft(shell)
        shell.setDraft(current.trim() ? `${current}\n${text}` : text)
        return true
      } catch (error) {
        console.warn('[prompt-deck] 插入失败', error)
        return false
      }
    }

    // ── 组件 ──────────────────────────────────────────────────────────────
    function Icon({ name }) {
      const paths = {
        plus: ['M12 5v14', 'M5 12h14'],
        close: ['M6 6l12 12', 'M18 6L6 18'],
        search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M16.5 16.5L21 21'],
        more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
        back: ['M15 5l-7 7 7 7'],
      }
      const list = paths[name] || []
      return h(
        'svg',
        { className: 'pd-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        list.map((d, i) => h('path', { key: i, d })),
      )
    }

    /** 输入框正下方那一行胶囊。 */
    function CapsuleRow(props) {
      const { sessionId } = props || {}
      const deck = useDeck()
      const [drawerOpen, setDrawerOpen] = React.useState(false)
      const [pending, setPending] = React.useState(null)

      const top = topSnippets(deck.items, MAX_CAPSULES)

      function pick(item) {
        const vars = item.vars && item.vars.length ? item.vars : parseVars(item.body)
        if (vars.length) {
          setPending({ item, vars })
          return
        }
        if (insertText(sessionId, item.body)) recordUse(item.id).catch(() => {})
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'pd-row', 'data-prompt-deck': 'capsules' },
          h('span', { className: 'pd-row-label', title: '常用提示词：点一下就把内容填进输入框' }, '提示词'),
          h(
            'div',
            { className: 'pd-chips' },
            top.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'pd-chip',
                  title: item.body.slice(0, 200),
                  onClick: () => pick(item),
                },
                h('span', { className: 'pd-chip-label' }, item.title),
                item.uses > 0 ? h('span', { className: 'pd-chip-count' }, String(item.uses)) : null,
              ),
            ),
            top.length === 0
              ? h('span', { className: 'pd-row-empty' }, '还没有常用提示词')
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pd-chip pd-chip-add',
              title: '打开提示词牌组',
              onClick: () => setDrawerOpen(true),
            },
            h(Icon, { name: 'plus' }),
            top.length === 0 ? h('span', { className: 'pd-chip-label' }, '添加') : null,
          ),
        ),
        drawerOpen
          ? h(Drawer, {
              sessionId,
              onClose: () => setDrawerOpen(false),
              onRequestInsert: (item, values) => {
                const text = values ? fillVars(item.body, values) : item.body
                if (insertText(sessionId, text)) recordUse(item.id).catch(() => {})
              },
              onNeedVars: (item, vars) => setPending({ item, vars }),
            })
          : null,
        pending
          ? h(VarDialog, {
              vars: pending.vars,
              onCancel: () => setPending(null),
              onConfirm: (values) => {
                const text = fillVars(pending.item.body, values)
                if (insertText(sessionId, text)) recordUse(pending.item.id).catch(() => {})
                setPending(null)
              },
            })
          : null,
      )
    }

    /** 抽屉：搜索 + 分组 + 列表 + 编辑。 */
    function Drawer({ sessionId, onClose, onRequestInsert, onNeedVars }) {
      const deck = useDeck()
      const [query, setQuery] = React.useState('')
      const [group, setGroup] = React.useState('all')
      const [editing, setEditing] = React.useState(null)
      const [confirmId, setConfirmId] = React.useState('')
      const [menuId, setMenuId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')

      React.useEffect(() => {
        refresh()
      }, [])

      React.useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (editing) setEditing(null)
            else onClose()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [editing, onClose])

      const visible = deck.items
        .filter((item) => (group === 'all' ? true : item.group === group))
        .filter((item) => matchesQuery(item, query))
        .sort((a, b) => score(b) - score(a))

      async function handleDelete(id) {
        setBusy(true)
        setFailure('')
        try {
          await deleteSnippet(id)
          setConfirmId('')
          setMenuId('')
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          className: 'pd-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'pd-panel', role: 'dialog', 'aria-label': '提示词牌组' },
          editing
            ? h(Editor, {
                draft: editing,
                busy,
                onCancel: () => setEditing(null),
                onSave: async (draft) => {
                  setBusy(true)
                  setFailure('')
                  try {
                    await saveSnippet(draft)
                    setEditing(null)
                  } catch (error) {
                    setFailure(error instanceof Error ? error.message : String(error))
                  } finally {
                    setBusy(false)
                  }
                },
              })
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'pd-panel-head' },
                  h('span', { className: 'pd-panel-title' }, '提示词牌组'),
                  h(
                    'label',
                    { className: 'pd-search' },
                    h(Icon, { name: 'search' }),
                    h('input', {
                      className: 'pd-search-input',
                      placeholder: '搜索标题或内容',
                      value: query,
                      autoFocus: true,
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'pd-icon-btn', title: '关闭（Esc）', onClick: onClose },
                    h(Icon, { name: 'close' }),
                  ),
                ),
                h(
                  'div',
                  { className: 'pd-tabs' },
                  GROUPS.map((entry) =>
                    h(
                      'button',
                      {
                        key: entry.id,
                        type: 'button',
                        className: 'pd-tab',
                        'data-active': group === entry.id ? 'true' : 'false',
                        onClick: () => setGroup(entry.id),
                      },
                      entry.label,
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pd-tab pd-tab-new',
                      onClick: () =>
                        setEditing({ id: '', title: '', body: '', group: group === 'all' ? 'my' : group }),
                    },
                    '＋ 新建',
                  ),
                ),
                failure ? h('div', { className: 'pd-error' }, failure) : null,
                h(
                  'div',
                  { className: 'pd-list' },
                  visible.length === 0
                    ? h(
                        'div',
                        { className: 'pd-empty' },
                        deck.loaded ? '还没有提示词。点右上角「＋ 新建」写下第一条。' : '正在读取…',
                      )
                    : visible.map((item) =>
                        h(
                          'div',
                          { key: item.id, className: 'pd-item' },
                          h(
                            'div',
                            { className: 'pd-item-main' },
                            h(
                              'div',
                              { className: 'pd-item-title' },
                              item.title,
                              h(
                                'span',
                                { className: 'pd-badge' },
                                (GROUPS.find((entry) => entry.id === item.group) || { label: '我的' }).label,
                              ),
                              item.uses > 0 ? h('span', { className: 'pd-badge pd-badge-quiet' }, `用过 ${item.uses} 次`) : null,
                            ),
                            h('div', { className: 'pd-item-body' }, item.body),
                          ),
                          h(
                            'div',
                            { className: 'pd-item-actions' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pd-btn pd-btn-primary',
                                onClick: () => {
                                  const vars = item.vars && item.vars.length ? item.vars : parseVars(item.body)
                                  if (!vars.length) {
                                    onRequestInsert(item)
                                    onClose()
                                    return
                                  }
                                  onNeedVars(item, vars)
                                  onClose()
                                },
                              },
                              '插入',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'pd-icon-btn',
                                title: '更多',
                                onClick: () => setMenuId(menuId === item.id ? '' : item.id),
                              },
                              h(Icon, { name: 'more' }),
                            ),
                          ),
                          menuId === item.id
                            ? h(
                                'div',
                                { className: 'pd-menu' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'pd-menu-item',
                                    onClick: () => {
                                      setMenuId('')
                                      setEditing({ id: item.id, title: item.title, body: item.body, group: item.group })
                                    },
                                  },
                                  '编辑',
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'pd-menu-item',
                                    onClick: () => {
                                      setMenuId('')
                                      setEditing({ id: '', title: `${item.title}（副本）`, body: item.body, group: item.group })
                                    },
                                  },
                                  '复制一份',
                                ),
                                confirmId === item.id
                                  ? h(
                                      'div',
                                      { className: 'pd-menu-confirm' },
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'pd-menu-item pd-menu-danger',
                                          disabled: busy,
                                          onClick: () => handleDelete(item.id),
                                        },
                                        `确认删除「${item.title}」`,
                                      ),
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'pd-menu-item',
                                          onClick: () => setConfirmId(''),
                                        },
                                        '取消',
                                      ),
                                    )
                                  : h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'pd-menu-item pd-menu-danger',
                                        onClick: () => setConfirmId(item.id),
                                      },
                                      '删除',
                                    ),
                              )
                            : null,
                        ),
                      ),
                ),
              ),
        ),
      )
    }

    /** 变量填充：有 {{xxx}} 就弹这一层。 */
    function VarDialog({ vars, onCancel, onConfirm }) {
      const [values, setValues] = React.useState(() => Object.fromEntries(vars.map((name) => [name, ''])))
      return h(
        'div',
        {
          className: 'pd-scrim pd-scrim-top',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h(
          'div',
          { className: 'pd-dialog', role: 'dialog', 'aria-label': '填写变量' },
          h('div', { className: 'pd-panel-title' }, '填一下占位符'),
          h('div', { className: 'pd-hint' }, '留空的话，占位符会原样留在输入框里，你可以在里面继续改。'),
          vars.map((name) =>
            h(
              'label',
              { key: name, className: 'pd-field' },
              h('span', { className: 'pd-field-label' }, name),
              h('input', {
                className: 'pd-input',
                value: values[name],
                autoFocus: name === vars[0],
                onChange: (event) => setValues({ ...values, [name]: event.target.value }),
              }),
            ),
          ),
          h(
            'div',
            { className: 'pd-dialog-actions' },
            h('button', { type: 'button', className: 'pd-btn', onClick: onCancel }, '取消'),
            h('button', { type: 'button', className: 'pd-btn pd-btn-primary', onClick: () => onConfirm(values) }, '填好了'),
          ),
        ),
      )
    }

    /** 新建 / 编辑表单。 */
    function Editor({ draft, busy, onCancel, onSave }) {
      const [title, setTitle] = React.useState(draft.title || '')
      const [body, setBody] = React.useState(draft.body || '')
      const [group, setGroup] = React.useState(draft.group || 'my')
      const vars = parseVars(body)
      const canSave = Boolean(body.trim()) && !busy

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'pd-panel-head' },
          h(
            'button',
            { type: 'button', className: 'pd-icon-btn', title: '返回', onClick: onCancel },
            h(Icon, { name: 'back' }),
          ),
          h('span', { className: 'pd-panel-title' }, draft.id ? '编辑提示词' : '新建提示词'),
        ),
        h(
          'div',
          { className: 'pd-form' },
          h(
            'label',
            { className: 'pd-field' },
            h('span', { className: 'pd-field-label' }, '标题'),
            h('input', {
              className: 'pd-input',
              value: title,
              placeholder: '例如：代码审查',
              autoFocus: true,
              onChange: (event) => setTitle(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'pd-field' },
            h('span', { className: 'pd-field-label' }, '分组'),
            h(
              'select',
              { className: 'pd-input', value: group, onChange: (event) => setGroup(event.target.value) },
              GROUPS.filter((entry) => entry.id !== 'all').map((entry) =>
                h('option', { key: entry.id, value: entry.id }, entry.label),
              ),
            ),
          ),
          h(
            'label',
            { className: 'pd-field' },
            h('span', { className: 'pd-field-label' }, '内容'),
            h('textarea', {
              className: 'pd-textarea',
              value: body,
              rows: 12,
              placeholder: '写下要填进输入框的话。用 {{关注点}} 这样的写法可以留下占位符。',
              onChange: (event) => setBody(event.target.value),
            }),
          ),
          vars.length
            ? h(
                'div',
                { className: 'pd-vars' },
                h('span', { className: 'pd-field-label' }, '识别到的占位符'),
                vars.map((name) => h('span', { key: name, className: 'pd-var' }, name)),
              )
            : h('div', { className: 'pd-hint' }, '想留个空让你每次自己填？写上 {{变量名}} 就行。'),
          h(
            'div',
            { className: 'pd-dialog-actions' },
            h('button', { type: 'button', className: 'pd-btn', onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'pd-btn pd-btn-primary',
                disabled: !canSave,
                onClick: () => onSave({ id: draft.id, title: title.trim() || body.trim().slice(0, 20), body, group }),
              },
              busy ? '保存中…' : '保存',
            ),
          ),
        ),
      )
    }

    // ── 样式 ──────────────────────────────────────────────────────────────
    // 只用主题 token，明暗两套自动跟着走；颜色字面量一概不写。
    const CSS = `
/* 挂在 conversation.input.dock：父容器 composerStack 是纵向 flex，天然独占一行，
   不用再和宿主 dock 里的 ContextMeter 抢位置。宽度对齐输入框卡片。 */
.pd-row { display:flex; flex:0 0 auto; box-sizing:border-box; align-items:center; gap:8px; width:100%; max-width:var(--dsh-composer-card-max-width,100%); min-width:0; margin:0 auto; padding:0 2px 2px; }
.pd-row-label { flex:0 0 auto; font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary); letter-spacing:.02em; user-select:none; cursor:default; }
.pd-row-empty { font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary); }
.pd-chips { display:flex; flex:1 1 auto; align-items:center; gap:6px; min-width:0; overflow-x:auto; scrollbar-width:none; }
.pd-chips::-webkit-scrollbar { display:none; }
.pd-chip { display:inline-flex; flex:0 0 auto; align-items:center; gap:4px; max-width:200px; padding:3px 10px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; cursor:pointer; transition:background .12s ease,color .12s ease,border-color .12s ease; }
.pd-chip:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.pd-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pd-chip-count { font-size:10px; opacity:.6; }
.pd-chip-add { color:var(--dsw-alias-brand-primary); border-style:dashed; }
.pd-icon { width:14px; height:14px; display:block; }
.pd-scrim { position:fixed; inset:0; z-index:60; display:flex; align-items:flex-end; justify-content:center; padding-bottom:88px; background:rgba(0,0,0,.28); }
.pd-scrim-top { z-index:70; align-items:center; padding-bottom:0; }
.pd-panel { width:min(720px,calc(100vw - 32px)); max-height:min(70vh,640px); display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,.28); overflow:hidden; }
.pd-panel-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.pd-panel-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); flex:0 0 auto; }
.pd-search { display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0; padding:4px 8px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-tertiary); }
.pd-search-input { flex:1 1 auto; min-width:0; border:0; outline:0; background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; }
.pd-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; flex:0 0 auto; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.pd-icon-btn:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.pd-tabs { display:flex; align-items:center; gap:4px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); flex-wrap:wrap; }
.pd-tab { padding:3px 10px; border-radius:999px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; }
.pd-tab:hover { background:var(--dsw-alias-bg-layer-2); }
.pd-tab[data-active="true"] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l1); }
.pd-tab-new { margin-left:auto; color:var(--dsw-alias-brand-primary); }
.pd-list { flex:1 1 auto; overflow-y:auto; padding:6px; }
.pd-item { position:relative; display:flex; align-items:flex-start; gap:8px; padding:8px 10px; border-radius:10px; }
.pd-item:hover { background:var(--dsw-alias-bg-layer-2); }
.pd-item-main { flex:1 1 auto; min-width:0; }
.pd-item-title { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--dsw-alias-label-primary); font-weight:500; }
.pd-item-body { margin-top:3px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.pd-badge { flex:0 0 auto; padding:0 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-tertiary); font-size:10px; font-weight:400; line-height:16px; }
.pd-badge-quiet { background:transparent; }
.pd-item-actions { display:flex; align-items:center; gap:4px; flex:0 0 auto; }
.pd-btn { padding:3px 10px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.pd-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.pd-btn:disabled { opacity:.5; cursor:default; }
.pd-btn-primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.pd-menu { position:absolute; right:8px; top:calc(100% - 4px); z-index:5; min-width:150px; padding:4px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); box-shadow:0 10px 28px rgba(0,0,0,.2); }
.pd-menu-item { display:block; width:100%; text-align:left; padding:5px 8px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.pd-menu-item:hover { background:var(--dsw-alias-bg-layer-2); }
.pd-menu-danger { color:var(--dsw-alias-state-error-primary); }
.pd-menu-confirm { margin-top:2px; padding-top:2px; border-top:1px solid var(--dsw-alias-border-l1); }
.pd-empty { padding:28px 12px; text-align:center; font-size:12px; color:var(--dsw-alias-label-tertiary); }
.pd-error { margin:8px 12px 0; padding:6px 10px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-error-primary); font-size:12px; }
.pd-dialog { width:min(420px,calc(100vw - 32px)); display:flex; flex-direction:column; gap:10px; padding:16px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,.3); }
.pd-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
.pd-form { padding:12px; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
.pd-field { display:flex; flex-direction:column; gap:4px; }
.pd-field-label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.pd-input { width:100%; box-sizing:border-box; padding:6px 9px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; outline:0; }
.pd-input:focus { border-color:var(--dsw-alias-brand-primary); }
.pd-textarea { width:100%; box-sizing:border-box; padding:8px 9px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; line-height:1.6; resize:vertical; outline:0; font-family:inherit; }
.pd-textarea:focus { border-color:var(--dsw-alias-brand-primary); }
.pd-hint { font-size:11px; line-height:1.6; color:var(--dsw-alias-label-tertiary); }
.pd-vars { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.pd-var { padding:1px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-secondary); font-size:11px; }
`

    function apply(ctx) {
      RUNTIME = ctx

      const existing = document.querySelector('style[data-dsh-prompt-deck]')
      if (existing) existing.remove()
      const style = document.createElement('style')
      style.setAttribute('data-dsh-prompt-deck', 'true')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(
        () => () => {
          style.remove()
        },
        'prompt-deck: styles',
      )

      // 挂在输入框正上方。宿主自己的 todo 面板（order 0）和排队消息（order 20）
      // 也在这个 slot 里，排在它们之后最贴近输入框。
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'prompt-deck',
            order: 30,
            inject: (sessionId) => ({ sessionId }),
          },
          CapsuleRow,
        ),
      )

      refresh()
    }

    const inject = ['slots', 'sessions', 'conversation']

    return { apply, inject }
  },
})