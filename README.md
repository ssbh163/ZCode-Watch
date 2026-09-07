# chrome-watch — 0.1.0

手动登记多把 GLM Coding Plan API Key,集中监控每把 Key 的**自然月用量**(预期 3 把左右):

| 显示项 | 内容 |
|---|---|
| 🏷 套餐档位 | LITE / PRO / MAX 等(取自官方监控接口) |
| 📊 月度进度条 | 已用百分比,分母为手动设置的总额度(默认 17.5 亿) |
| 📈 三项额度 | 总使用额度(加权)/ 高峰期使用 / 非高峰期使用 |
| ⚠ 满额提醒 | 用满 100% 的 Key:悬浮窗红色横幅 + 新会话注入提醒 + 命令输出建议删除 |

**计费口径**(与智谱 Coding Plan 官方规则一致):

- 总使用额度 = **非高峰期 token ×1 + 高峰期 token ×3**
- 高峰期 = 工作日(周一至周五)14:00–18:00
- 月度周期为自然月,**每月 1 号自动重置**,从当月 1 日 00:00 起累计
- 时间均按本机本地时间计算(假定为北京时间)

与 [zcode-usage](../zcode-usage-plugin) 的分工:zcode-usage 看「当前登录这一把 Key」的 5 小时池 / 每周额度 / MCP;chrome-watch 看「手动登记的多把 Key」的月度额度消耗。查询接口、认证方式、悬浮窗壳机制均复用 zcode-usage 的成熟链路。

## 前提条件

- [ZCode](https://zcode.z.ai) 桌面版
- Node.js ≥ 18(终端输入 `node -v` 检查)
- 若干把智谱 Coding Plan 的 API Key(开放平台「API Keys」页获取)

## 安装

**本地目录安装**:

1. ZCode → 插件市场 → 发现 → **+** → **本地目录**,选中本仓库根目录(包含 `marketplace.json` 的那一层)
2. 安装 **chrome-watch**

安装后**新开一个对话**(命令与技能在会话启动时加载),悬浮窗会在会话开始时自动弹出(仅 Windows)。

## 使用

### 1. 登记第一把 Key(二选一)

- **对话内(推荐)**:新会话直接说:「添加一个 chrome-watch key,名字叫主力,Key 是 xxxxxxxx」
- **手动**:编辑 `~/.zcode/chrome-watch.json`(Windows 为 `%USERPROFILE%\.zcode\chrome-watch.json`),悬浮窗右键菜单 → 「编辑 Key 配置…」可一键创建模板并打开:

```json
{
  "keys": [
    { "id": "key-1", "name": "主力", "provider": "bigmodel",
      "apiKey": "你的Key", "monthlyQuota": 1750000000 }
  ]
}
```

- `provider`:`bigmodel`(智谱开放平台,默认)| `zai`(智谱国际)
- `monthlyQuota`:该 Key 的月度总额度(加权 token),不填默认 17.5 亿
- 删除 Key = 移除该对象(缓存自动清理)

### 2. 查看用量

- **桌面悬浮窗(Windows)**:每把 Key 一张卡片,10 分钟自动刷新;Ctrl+Shift+G 显隐(zcode-usage 的 Ctrl+G 不冲突);拖拽移动、位置记忆;配色跟随 ZCode 外观深浅
- **对话内**:输入 `/chrome-watch:watch`,或直接问「Key 用量怎么样了」「哪把该删了」
- **终端**:`node <插件目录>/scripts/chrome-watch.mjs`(加 `--json` 看原始数据)

### 3. 满额提醒(三通道)

| 通道 | 时机 | 形式 |
|---|---|---|
| 悬浮窗卡片 | 常驻 | 红色横幅「⚠ 本月已用满 100%,建议删除该 Key」 |
| 新会话注入 | 每个新会话开始 | 一行警告(读本地缓存,不打接口) |
| 会话命令 / 提问 | 主动查询时 | 对超限 Key 给出删除建议 |

## 隐私与安全

- 插件不含任何密钥;API Key 只存本机 `~/.zcode/chrome-watch.json`
- 请求只发往智谱官方域名(`open.bigmodel.cn` / `api.z.ai`),不经过第三方;查询走官方监控接口,不消耗 prompt 额度
- Key 在悬浮窗与对话输出中一律脱敏(只显示尾号),不进命令行参数

## 常见问题

**Q:卡片显示「Key 无效」/ HTTP 401?**
该 Key 已失效、被更换,或不是 Coding Plan 专用 Key(普通按量付费 Key 查不到套餐数据)。检查 `~/.zcode/chrome-watch.json` 里的 apiKey。

**Q:数字和官方网页对不上?**
以智谱开放平台「个人编程套餐 > 用量统计」网页为权威;本插件数字来自同一个监控接口,字段若被官方调整,更新脚本中的映射即可(集中在 `chrome-watch.mjs` 一处)。

**Q:每月 1 号怎么重置的?**
查询窗口天然是「当月 1 日 00:00 → 现在」;缓存文件里的逐日高峰数据在新月份自动清空,无需手动操作。

**Q:月初第一次刷新怎么有点慢?**
高峰期(工作日 14–18 点)不连续,需要逐日查询;月中首刷会回填当月已过的工作日(≤22 个请求/Key,一次性),之后稳态每次只要 3 个请求/Key,已闭窗日期全部走缓存。

**Q:非 Windows 系统有悬浮窗吗?**
目前只有 Windows 悬浮窗;macOS/Linux 上技能、命令、终端 CLI 照常可用(启动器会静默跳过悬浮窗)。

## 目录结构

```
chrome-watch/                               ← 市场仓库根目录
├── .zcode-plugin/marketplace.json        ← 市场清单
├── marketplace.json                      ← 根目录副本(兼容不同读取位置)
├── PROJECT.md                            ← 项目文档(需求/设计/实施计划)
└── plugins/chrome-watch/                 ← 插件本体
    ├── .zcode-plugin/plugin.json
    ├── hooks/hooks.json                  ← SessionStart:拉起悬浮窗 + 满额注入提醒
    ├── commands/watch.md                 ← /chrome-watch:watch 命令
    └── skills/chrome-watch/
        ├── SKILL.md
        └── scripts/
            ├── chrome-watch.mjs          ← 查询引擎(零依赖,单份正本)
            ├── chrome-watch.test.mjs     ← 纯函数单测(node --test)
            ├── chrome-watch-widget.ps1   ← Windows 多卡片悬浮窗(纯 UI 壳)
            ├── widget-launch.mjs         ← 跨平台启动器(按平台分发)
            └── widget-launch.vbs         ← Windows 免黑窗启动器
```

运行期数据(不在仓库内):配置 `~/.zcode/chrome-watch.json`(人写)、缓存 `~/.zcode/chrome-watch-cache.json`(机器生成,勿手改)。

## 卸载

ZCode 设置 → 插件管理 → 已安装 → chrome-watch → 卸载。悬浮窗会随插件缓存被移除而自动退出,不残留开机自启或后台进程;`~/.zcode/chrome-watch*.json` 配置与缓存文件可手动删除。

## 更新日志

- **0.1.0**:首个版本。多 Key 月度用量监控(加权:高峰×3 + 非高峰×1)、Windows 多卡片悬浮窗、满额三通道提醒、会话技能与 `/chrome-watch:watch` 命令、逐日高峰缓存(稳态 3 请求/Key/次)。

## License

MIT
