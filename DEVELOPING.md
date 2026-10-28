# 开发笔记

面向改代码的人。只想知道怎么用的看 [README.md](README.md)。

## 文件结构

零依赖、零构建：`index.js` 在 Host（Node）侧跑，`client.js` 在浏览器侧跑，两个都是手写文件，没有编译步骤。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单。`dsh.bundle.patch` 指向补丁文件，`dsh.client` 声明浏览器侧入口 |
| `cordis.patch.yml` | 补丁：往 profile 的插件树里插一行，指向本包 |
| `index.js` | Host 半：读写 `snippets.json`，开 4 个 HTTP 接口 |
| `client.js` | Client 半：胶囊行、抽屉、编辑器、变量弹窗 |
| `locale/zh.json`、`locale/en.json` | 插件列表里显示的名字和描述 |
| `icon.svg` | 插件列表里的图标 |
| `assets/icon.png` | 市场卡片用的位图（市场只收位图） |
| `smoke.mjs` | 自测：用假 ctx 跑一遍 Host 半的增删改查，再在 vm 里验证 Client 半的导出和 id |
| `awesome-entry.yml` | 待提交给 awesome-dsh-plugin 的收录条目 |

`node smoke.mjs` 会跑 17 项断言，改完代码先跑它。

## 三个容易再踩的坑

1. **`dsh.client` 里的 `inject` 只是排队顺序**，不是"允许 import"。Client 端不允许 `require` 任何 `@deepseek-ai/dsh-client-*` 包；React 来自宿主的模块表，直接 `require('react')` 即可。

2. **会话内的 slot 要拿 sessionId，写 `inject: (sessionId) => ({ sessionId })`**，别指望 slot props。`conversation.composer.dock` 传的是空对象；`conversation.input.dock` 传的是 `{ session, input }`，但用 inject 更稳，换挂载点也不用改。

3. **往输入框写字不要自己找 textarea**。走 `conversation.input.shell(sessionId).setDraft(text)`，宿主换布局也不用跟着改。读草稿要依次试 `shell.draftSnapshot`（可能是字符串，也可能是 `.draft`）和 `shell.state.getSnapshot().draft`。

## 挂载点为什么选 input.dock

一开始挂在 `conversation.composer.dock`（输入框**下**沿）。那个容器的 CSS 是 `display:flex` 且没有 `flex-wrap`，宿主还在同一个容器里硬编码了 ContextMeter（缓存命中 / 上下文占比），于是两边只能挤在一行。

`conversation.input.dock` 在输入框**上**沿，父容器 `composerStack` 是 `flex-direction:column`，天然一行一个。宿主的 todo 面板（`order: 0`）和排队消息（`order: 20`）也挂这儿，本插件用 `order: 30` 排在它们之后、紧贴输入框。

注意这个 slot 只在有会话时渲染（`zone` 为 `undefined` 时整块不渲染），空会话首页看不到胶囊行。

## 排序规则

`client.js` 里的 `score(item)`：

```js
uses * 10 + recency   // recency = 30 天内的线性衰减，0..1
```

也就是用过的次数占主导，最近用过的在同分情况下靠前。胶囊行取前 6 条（`MAX_CAPSULES`），超出部分在抽屉里。

## 发布到市场

`awesome-entry.yml` 是待提交的市场条目，`assets/icon.png` 是市场卡片用的位图（市场只收位图，拒收 SVG，所以从 `icon.svg` 单独渲染了一张 512px 的）。

1. 推到 `github.com/xuguangyao/dsh-prompt-deck`（仓库公开），给仓库加 topic `dsh-plugin`。
2. 确认 `package.json` 里有 `dsh.bundle.patch` —— 这是硬门槛，只声明 `dsh.client` 的包装不上，也是最常见的被拒原因。
3. 可选：发布 npm。注意本机 `npm config get registry` 可能是 npmmirror 镜像，**那是只读镜像，不能发布**，必须显式指定官方源：

   ```
   npm login --registry=https://registry.npmjs.org
   npm publish --registry=https://registry.npmjs.org --access public
   ```

   不发 npm 也能被收录，`repository` 字段已经指回仓库，只是市场不显示下载量。npm 账号是 `xgy-lab`，所以包名用 `@xgy-lab/dsh-prompt-deck` —— scope 必须等于账号名或自己创建的组织名，否则 `npm publish` 会 403。
4. 把 `awesome-entry.yml` 复制到 awesome-dsh-plugin 仓库的 `data/plugins/xuguangyao__dsh-prompt-deck.yml`（双下划线），提一个只包含这一个文件的 PR。**不要改那两个 README**，它们是脚本生成的，手改会让 CI 报 `READMEs are out of sync`。
5. 等 CI：条目数 ≤3 → `dsh.bundle` → 仓库满 1 天 → lint 与站点构建。失败会指明改什么，同一分支推修复即可，不用重开 PR。

想加截图：在仓库根放 `screenshots.json`，列 1 到 8 张相对路径图片，市场详情页会展示；不放则从 README 自动抽图。