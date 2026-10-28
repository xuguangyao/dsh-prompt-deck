# 提示词牌组 · dsh-prompt-deck

把常用提示词做成输入框正上方的一排胶囊，点一下就把内容填进输入框。带 `{{占位符}}` 的会先让你填，填完再插入。

零依赖、零构建：`index.js` 在 Node 侧跑，`client.js` 在浏览器侧跑，两个都是手写文件，没有编译步骤。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单。`dsh.bundle.patch` 指向补丁文件，`dsh.client` 声明浏览器侧入口 |
| `cordis.patch.yml` | 补丁：往 profile 的插件树里插一行，指向本包 |
| `index.js` | Host 半：读写 `snippets.json`，开 4 个 HTTP 接口 |
| `client.js` | Client 半：胶囊行、抽屉、编辑器、变量弹窗 |
| `locale/zh.json` | 插件列表里显示的名字和描述 |
| `icon.svg` | 插件列表里的图标 |

## 安装

在 DSH 的 Web 界面打开左侧栏「插件」页，选「安装本地插件 / bundle」，填入本目录的绝对路径：

```
D:\aiworkplace\deepseek-workplace\dsh-prompt-deck
```

装完看返回里的 `application` 字段：`applied` 表示已经生效。新建一个会话，输入框上方就会出现胶囊行。

## 使用

- **点胶囊**：内容直接填进当前输入框（草稿里已有字时另起一行追加）。
- **点最后一个 `＋`**：打开牌组抽屉，里面有搜索、分组、新建。
- 每条卡片右侧 `[插入]` 和 `⋯`（编辑 / 复制一份 / 删除）。
- 新建时在内容里写 `{{关注点}}`，保存后卡片上会标出识别到的占位符。

## 数据存在哪

```
%USERPROFILE%\.dsh\prompt-deck\snippets.json
```

就是一个普通 JSON 文件，可以直接看、直接备份、直接手改（改完刷新页面）。

想换位置，在 `cordis.patch.yml` 的 `config` 里加 `dataDir`：

```yaml
- insert:
    - id: prompt-deck
      name: '@xgy/dsh-prompt-deck'
      config:
        dataDir: D:/work/prompt-deck
```

## 开发笔记

三个当时踩过的点，改代码时容易再踩一次：

1. **`dsh.client` 里的 `inject` 只是排队顺序**，不是"允许 import"。Client 端不允许 `require` 任何 `@deepseek-ai/dsh-client-*` 包，React 来自宿主的模块表，直接 `require('react')` 即可。
2. **会话内的 slot 要拿 sessionId，写 `inject: (sessionId) => ({ sessionId })`**，别指望 slot props。`conversation.composer.dock` 传的是空对象；`conversation.input.dock` 传的是 `{ session, input }`，但用 inject 更稳，换挂载点也不用改。
3. **往输入框写字不要自己找 textarea**。走 `conversation.input.shell(sessionId).setDraft(text)`，宿主换布局也不用跟着改。

## 挂载点为什么从 composer.dock 换成 input.dock

一开始挂在 `conversation.composer.dock`（输入框**下**沿）。那个容器的 CSS 是 `display:flex` 且没有 `flex-wrap`，宿主还在同一个容器里硬编码了 ContextMeter（缓存命中 / 上下文占比），于是两边只能挤在一行。

`conversation.input.dock` 在输入框**上**沿，父容器 `composerStack` 是 `flex-direction:column`，天然一行一个。宿主的 todo 面板（`order: 0`）和排队消息（`order: 20`）也挂这儿，本插件用 `order: 30` 排在它们之后、紧贴输入框。注意这个 slot 只在有会话时渲染（`zone` 为 `undefined` 时整块不渲染），空会话首页看不到胶囊行。

样式只用了 `--dsw-alias-*` 主题变量，没有写死颜色，明暗主题都能自动跟随。

## 发布到市场

`awesome-entry.yml` 是待提交的市场条目，`assets/icon.png` 是市场卡片用的位图（市场只收位图，拒收 SVG，所以从 `icon.svg` 单独渲染了一张 512px 的）。

1. 推到 `github.com/xuguangyao/dsh-prompt-deck`（仓库公开），给仓库加 topic `dsh-plugin`。
2. 确认 `package.json` 里有 `dsh.bundle.patch` —— 这是硬门槛，只声明 `dsh.client` 的包装不上，也是最常见的被拒原因。
3. 可选：`npm publish --access public` 发布 `@xgy/dsh-prompt-deck`。不发 npm 也能被收录，`repository` 字段已经指回仓库。发之前确认 npm 上 `@xgy` 这个 scope 属于自己。
4. 把 `awesome-entry.yml` 复制到 awesome-dsh-plugin 仓库的 `data/plugins/xuguangyao__dsh-prompt-deck.yml`，提一个只包含这一个文件的 PR。**不要改那两个 README**，它们是脚本生成的，手改会让 CI 报 `READMEs are out of sync`。
5. 等 CI（条目数 ≤3 → `dsh.bundle` → 仓库满 1 天 → lint 与站点构建）和人工评审。CI 失败会指明改什么，同一分支推修复即可。

想加截图：在仓库根放 `screenshots.json`，列 1 到 8 张相对路径图片，市场详情页会展示；不放则从 README 抽图。