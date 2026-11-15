# GitHub Issue Helper

一个油猴脚本（Tampermonkey / Violentmonkey），把 GitHub Issue 列表里最常用的两件事变快：

1. **右键 issue → 直接在鼠标位置弹出原生 Assign 面板**（不用再进详情页、翻侧边栏）
2. **← / → 在 issue 之间前后跳转**（跟随列表页当前的筛选和排序）
3. **可选：无限滚动**，列表一直往下加载，不用点分页

> 所有写操作都走 GitHub 自己的组件，脚本不调用私有 API、不读取也不保存任何 token。

## 功能

### 1. 右键直接分配（复用 GitHub 原生下拉菜单）

在任意 issue 列表页（`https://github.com/<owner>/<repo>/issues`），用**鼠标右键**点某条 issue：

- 脚本自动勾选该行、点开 GitHub 原生的 **Assign** 按钮
- 把弹出的**原生** `Apply assignees` 面板挪到你右键的位置
- 面板里就是 GitHub 自带的 assignee 搜索、头像、多选、Save —— 脚本没有重写任何 UI

所以：

- 权限、校验、可分配名单和 GitHub 网页完全一致
- 勾选状态、批量操作栏都是 GitHub 自己的，取消面板后自动恢复原状

想用浏览器原生右键菜单时，按住 **Shift** 或 **Alt** 再右键即可。

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

### 方式 A：粘贴安装（私有仓库推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey
2. 打开扩展的「添加新脚本」
3. 把 [`gh-issue-helper.user.js`](./gh-issue-helper.user.js) 的内容整段粘贴进去，保存

### 方式 B：本地文件导入

Tampermonkey 的「实用工具 → 导入」选择一个本地 `.user.js` 文件。

> 本仓库是私有的，raw 链接需要 token，所以不提供一键 raw 安装地址。

## 设置

点油猴图标 → 本脚本的菜单项：

| 菜单项 | 说明 |
| --- | --- |
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
- 无限滚动加载出来的行需要跳转详情页才能分配（见上文）
- 没有该仓库写权限时，GitHub 本身不显示 Assign，脚本会提示
- GitHub 改版 DOM（`data-testid` 命中）可能导致失效，届时更新选择器即可
