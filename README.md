# GitHub Issue Helper

[![安装](https://img.shields.io/badge/安装-userscript-blue)](https://raw.githubusercontent.com/Phil-Fan/gh-issue-helper/main/gh-issue-helper.user.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

一个油猴脚本（Tampermonkey / Violentmonkey），把 GitHub Issue 列表改造成「左列表 + 右详情」的工作台：

1. **左右分栏**：左侧是 issue 列表，右侧直接看详情，点列表任意位置**不再跳转**；中间分隔线可拖动
2. **右键 issue → 直接在鼠标位置弹出原生 Assign 面板**（不用再进详情页、翻侧边栏）
3. **hover 时**，没有 assignee 的 issue 会浮出一个小 `Assign` 入口
4. **← / → 在 issue 之间前后跳转**（跟随列表页当前的筛选和排序）
5. **可选：无限滚动**，列表一直往下加载，不用点分页

> 所有写操作都走 GitHub 自己的组件，脚本不调用私有 API、不读取也不保存任何 token。

## 功能

### 0. 左右分栏：左列表 + 右详情

打开任意 issue 列表页（`https://github.com/<owner>/<repo>/issues`），页面会变成左右两栏：

- 左侧保留 GitHub 原生列表（筛选、排序、勾选全部可用）
- 右侧是一个**只读预览**，点击左侧任意 issue 就在这里显示标题、正文、评论
- 中间分隔线**可以拖动**调整宽度，双击复位，宽度会记住
- 地址栏不变，不会离开列表，也不会打断你的浏览位置
- 预览里的 issue 链接（包括 `#909` 这种交叉引用）继续在右栏打开
- 右栏顶部有「打开原页 ↗」，需要评论/改标签时跳过去

> 正文部分是 GitHub 返回的 HTML 快照（GitHub 不允许 iframe 嵌套），但右栏顶部和底部的**操作按钮是脚本自己接的**，可以直接用：
> `Assign`、`Close issue` / `Reopen issue`、评论框。配了 Token 就能直接写入，没配 Token 会打开原页。

### 1. 右键直接分配（复用 GitHub 原生下拉菜单）

在任意 issue 列表页（`https://github.com/<owner>/<repo>/issues`），用**鼠标右键**点某条 issue：

- 脚本自动勾选该行、点开 GitHub 原生的 **Assign** 按钮
- 把弹出的**原生** `Apply assignees` 面板挪到你右键的位置
- 面板里就是 GitHub 自带的 assignee 搜索、头像、多选、Save —— 脚本没有重写任何 UI

所以：

- 权限、校验、可分配名单和 GitHub 网页完全一致
- 勾选状态、批量操作栏都是 GitHub 自己的，取消面板后自动恢复原状

想用浏览器原生右键菜单时，按住 **Shift** 或 **Alt** 再右键即可。

### 1.5 hover 显示 Assign 入口

列表里没有 assignee 的 issue，鼠标移上去时行右侧会浮出一个小 `Assign` 胶囊：

- 已经有 assignee 的行不显示（保持原生头像）
- 这个按钮是浮层，不写进 GitHub 的 DOM，因此不会影响列表本身的勾选行为

### 1.55 右栏直接操作：Close / 评论 / Assign

右栏顶部有 `Assign` 和 `Close issue`（已关闭时变成 `Reopen issue`），底部有评论框：

- **Close / Reopen**：改 issue 状态，按钮文案和右栏状态会立即跟着变
- **评论**：输入后点 `Comment` 或按 `⌘ / Ctrl + Enter`，发布成功后右栏自动刷新
- **Assign**：弹出同一个紧凑分配下拉

这些操作需要 Token（见下节）。没有 Token 时点击**只会提示，不会跳走、也不会偷偷打开新标签**。

### 1.6 点一下就分配（可选 Token）

默认点击胶囊会打开 GitHub 原生的 `Apply assignees` 面板（在分栏较窄时会经过「更多」菜单，层级较多）。

如果配一个 Token，就能换成**一个紧凑的小下拉**：搜索框 + 头像列表，**点一下直接分配完成**，不用再点 Save。

配置方式：油猴菜单 → 「设置 GitHub Token」→ 粘贴 Token。

- 建议用 fine-grained token，只勾选目标仓库的 **Issues: Read and write**
- Token 只存在浏览器本地 `localStorage`，脚本不会发给除 `api.github.com` 以外的任何地方
- 留空并确定 = 清除 Token，回到原生面板模式

### 2. ← / → 切换 issue

在 issue 详情页按 **← / →**，跳到列表里的上一个 / 下一个 issue。

顺序来自列表页当前的筛选与排序（例如 `is:issue state:open`），跨页时会自动取上一页 / 下一页。
如果当前 issue 不在你最近打开的列表里，脚本会按筛选条件逐页定位；实在找不到就退回「按编号 ±1」。

### 3. 无限滚动（默认关闭）

在列表页滚滚到底部，自动加载下一页并追加到当前列表，取代分页器。
默认**关闭**，通过油猴菜单开启。

> 说明：追加进来的行不在 GitHub 的 React 树里，所以对它们右键无法直接勾选。
> 此时脚本会打开该 issue 详情页并自动弹出原生 Assign 面板（一次跳转完成分配）。

## 安装

### 方式 A：一键安装（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari）
2. 点击下面的安装链接，Tampermonkey 会弹出安装页，点「安装」：

   **<https://raw.githubusercontent.com/Phil-Fan/gh-issue-helper/main/gh-issue-helper.user.js>**

> Chrome 138+ 需要额外开一次开关：`chrome://extensions` → 打开右上角「开发者模式」→ Tampermonkey 的「详情」→ 打开「允许用户脚本」。

### 方式 B：手动粘贴

1. 打开油猴管理面板 → 「添加新脚本」
2. 把 [`gh-issue-helper.user.js`](./gh-issue-helper.user.js) 的内容整段粘贴进去，保存

安装后打开任意 issue 列表页，脚本会自动生效，控制台会打印 `[gh-issue-helper] 已加载`。

## 设置

点油猴图标 → 本脚本的菜单项：

| 菜单项 | 说明 |
| --- | --- |
| ✓ 左右分栏预览（右栏看详情） | 开关左右分栏 |
| ✓ 已设置 Token / 设置 GitHub Token | 配置「点一下就分配」 |
| ✓ 键盘 ← / → 切换 issue | 开关键盘导航 |
| ✓ 无限滚动（不换页） | 开关无限滚动，默认关闭 |
| 恢复默认设置 | 重置为默认配置 |

配置保存在 `localStorage['ghih:config']`。

## 实现要点

- **复用而不是重写**：列表页选中 issue 后，GitHub 会显示原生批量操作栏，其中就有 `Assign` 按钮。脚本只是替你完成「勾选 → 点 Assign」。
- **定位**：面板用 CSS anchor positioning（`position-anchor`）定位，直接写 `left/top` 会被覆盖，所以用 `transform` 做视觉位移，并在几帧内反复校准高度变化。
- **列表顺序**：列表页把当前可见的 issue 编号写入 `sessionStorage`；详情页据此计算前后。跨页时抓取列表页 HTML（带 5 分钟缓存）解析，不消耗 API 配额。

## 已知限制

- 只处理 Issues 页，不含 Pull requests
- 右侧正文是静态快照：代码高亮正常，但正文里的「编辑标题」「Subscribe」等原生按钮不可用
- 右栏的 Close / 评论 / Assign 需要 Token；没配 Token 时点击只提示、不执行
- Label、Milestone 等仍在原页面操作
- 紧凑分配依赖 Token；不配 Token 时走原生面板，功能一样但多一步 Save
- 无限滚动加载出来的行需要跳转详情页才能分配（见上文）
- 没有该仓库写权限时，GitHub 本身不显示 Assign，脚本会提示
- GitHub 改版 DOM（`data-testid` 命中）可能导致失效，届时更新选择器即可
