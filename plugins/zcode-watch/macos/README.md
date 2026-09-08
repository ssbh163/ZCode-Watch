# zcode-watch macOS 悬浮窗

把多把 GLM Coding Plan API Key 的**自然月用量**做成一个 macOS 常驻悬浮窗：
每把 Key 一张卡片（档位 / 加权进度条 / 高峰·非高峰用量 / 重置倒计时），
用满 100% 的 Key 红色横幅提醒删除。与 Windows 悬浮窗同数据同布局。

- 无边框圆角磨砂面板，始终悬浮在其他窗口上面，按住任意位置拖动，位置自动记忆
- 全局快捷键 **Ctrl + Shift + G** 唤出 / 收起（可改；Ctrl+G 留给 zcode-usage，两窗共存不冲突）
- 菜单栏 ⚡ 图标兜底；不占 Dock、不抢焦点
- 手动 ↻ 实时刷新；自动刷新默认 **110 分钟**一次（与引擎增量拉取窗配套，每次只拉最近约 2 小时的增量）
- 首次刷新会全量拉取当月账单明细（约几秒），之后都是增量

数据一律来自 `scripts/zcode-watch.mjs --json`（引擎单份正本），本应用是纯 UI 壳，
口径与 Windows 悬浮窗、终端 CLI、ZCode 会话命令完全一致。

---

## 安装（3 步）

### 前提

| 需要 | 检查命令 | 没有的话 |
|---|---|---|
| macOS 12+ | 左上角  → 关于本机 | — |
| Xcode 命令行工具 | `xcode-select -p` | 终端执行 `xcode-select --install`，装完重开终端 |
| Node.js 18+ | `node -v` | `brew install node`，或去 https://nodejs.org 下载 |

### 编译

把整个 `macos` 文件夹放在任意位置，终端执行：

```bash
cd <macos 目录>
bash build.sh
```

成功后同目录出现 `ZCodeWatchHUD.app`。`open ZCodeWatchHUD.app` 启动。

### 配置 Key

编辑 `~/.zcode/zcode-watch.json`（或在 ZCode 对话里说「添加一个 zcode-watch key，名字 xx，Key 是 xxx」）：

```json
{ "keys": [ { "id": "key-1", "name": "主力", "provider": "bigmodel",
              "apiKey": "你的完整Key", "monthlyQuota": 1750000000 } ] }
```

面板空态也会显示这个路径。配置与缓存（`~/.zcode/zcode-watch-cache.json`）与
Windows / CLI 三端共用一份。

---

## 可选配置

`~/.zcode/zcode-watch-hud/config.json`（改完退出应用重开生效）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `hotkey` | `"ctrl+shift+g"` | 支持 `ctrl/cmd/shift/alt` 组合 |
| `refreshIntervalMinutes` | `110` | 自动刷新间隔（分钟） |
| `autoShowOnStart` | `true` | 启动时是否自动弹出 |
| `nodePath` | 自动探测 | node 路径（nvm/homebrew 自动发现，一般不用填） |

ZCode SessionStart 钩子会自动唤出面板（插件安装后生效）；开机自启可在
系统设置 → 通用 → 登录项与扩展 中添加本应用。

---

## 常见问题

**Q：提示「找不到 zcode-watch.mjs」？**
`scripts/zcode-watch.mjs` 要和 `.app` 在同一目录（build.sh 自动同步）；或确认 ZCode 已安装 zcode-watch 插件（回退读插件缓存）。

**Q：提示「找不到 node」？**
装好 Node.js 后重开应用；还不行就在 config.json 里加 `"nodePath": "$(which node)"`。

**Q：快捷键没反应？**
可能被其他应用占用，改 config.json 的 `hotkey` 后重开；期间用菜单栏 ⚡。

---

## 目录内容

| 文件 | 作用 |
|---|---|
| `ZCodeWatchHUD.swift` | 主程序（Swift + AppKit 单文件，纯 UI 壳） |
| `build.sh` | 一键编译打包（含脚本同步） |
| `launch.sh` | SessionStart 钩子幂等启动器 |
| `scripts/` | 引擎脚本副本，build.sh 自动从 skills 正本同步（生成物，不入库） |
