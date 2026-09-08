# zcode-watch — 0.4.0

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

与 [zcode-usage](../zcode-usage-plugin) 的分工:zcode-usage 看「当前登录这一把 Key」的 5 小时池 / 每周额度 / MCP;zcode-watch 看「手动登记的多把 Key」的月度额度消耗。查询接口、认证方式、悬浮窗壳机制均复用 zcode-usage 的成熟链路。

## 前提条件

- [ZCode](https://zcode.z.ai) 桌面版
- Node.js ≥ 18(终端输入 `node -v` 检查)
- 若干把智谱 Coding Plan 的 API Key(开放平台「API Keys」页获取)

## 安装

**本地目录安装**:

1. ZCode → 插件市场 → 发现 → **+** → **本地目录**,选中本仓库根目录(包含 `marketplace.json` 的那一层)
2. 安装 **zcode-watch**

安装后**新开一个对话**(命令与技能在会话启动时加载),悬浮窗会在会话开始时自动弹出(仅 Windows)。

## 使用

### 1. 登记第一把 Key(二选一)

- **对话内(推荐)**:新会话直接说:「添加一个 zcode-watch key,名字叫主力,Key 是 xxxxxxxx」
- **手动**:编辑 `~/.zcode/zcode-watch.json`(Windows 为 `%USERPROFILE%\.zcode\zcode-watch.json`),悬浮窗右键菜单 → 「编辑 Key 配置…」可一键创建模板并打开:

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

- **桌面悬浮窗(Windows / macOS)**:每把 Key 一张卡片(同账号多 Key 各自独立峰时拆分),手动 ↻ 实时刷新、自动每 110 分钟一次(增量只拉最近 2 小时);快捷键 Ctrl+Shift+G 显隐。macOS 版为原生 AppKit 悬浮窗(macos/ 目录执行一次 `bash build.sh` 编译)(zcode-usage 的 Ctrl+G 不冲突);拖拽移动、位置记忆;配色跟随 ZCode 外观深浅
- **对话内**:输入 `/zcode-watch:watch`,或直接问「Key 用量怎么样了」「哪把该删了」
- **终端**:`node <插件目录>/scripts/zcode-watch.mjs`(加 `--json` 看原始数据)

### 3. 满额提醒(三通道)

| 通道 | 时机 | 形式 |
|---|---|---|
| 悬浮窗卡片 | 常驻 | 红色横幅「⚠ 本月已用满 100%,建议删除该 Key」 |
| 新会话注入 | 每个新会话开始 | 一行警告(读本地缓存,不打接口) |
| 会话命令 / 提问 | 主动查询时 | 对超限 Key 给出删除建议 |

## 隐私与安全

- 插件不含任何密钥;API Key 只存本机 `~/.zcode/zcode-watch.json`
- 请求只发往智谱官方域名(`open.bigmodel.cn` / `api.z.ai`),不经过第三方;查询走官方监控接口,不消耗 prompt 额度
- Key 在悬浮窗与对话输出中一律脱敏(只显示尾号),不进命令行参数

## 常见问题

**Q:卡片显示「Key 无效」/ HTTP 401?**
该 Key 已失效、被更换,或不是 Coding Plan 专用 Key(普通按量付费 Key 查不到套餐数据)。检查 `~/.zcode/zcode-watch.json` 里的 apiKey。

**Q:数字和官方网页对不上?**
本插件按 Key 数据来自「费用账单 → 费用明细」同一接口(分钟级,峰时判定到分钟);与「按 API Key 调用统计」的合计存在 <0.5% 的结算口径差(明细实时、聚合结算滞后),与「用量统计」页的账号级口径另有约 2% 差(是否含工具调用等),均属正常。

**Q:每月 1 号怎么重置的?**
查询窗口天然是「当月 1 日 00:00 → 现在」;缓存文件里的逐日高峰数据在新月份自动清空,无需手动操作。

**Q:月初/断档后第一次刷新怎么有点慢?**
账单明细按月整存、无时间过滤参数,首刷会把当月已有明细全量拉取一次(本账号实测 3,300+ 行 7 页),之后每次只按缺口增量拉取(保底 2 小时,稳态 1 页);断档多久就补多久,同一段数据从不重复拉取。

**Q:非 Windows 系统有悬浮窗吗?**
macOS 12+ 有原生悬浮窗:进入插件 `macos/` 目录执行 `bash build.sh` 编译一次(ZCodeWatchHUD.app),SessionStart 钩子会自动唤出;快捷键 Ctrl+Shift+G。Linux 无悬浮窗,技能 / 命令 / CLI 照常可用。

## 目录结构

```
zcode-watch/                               ← 市场仓库根目录
├── .zcode-plugin/marketplace.json        ← 市场清单
├── marketplace.json                      ← 根目录副本(兼容不同读取位置)
├── PROJECT.md                            ← 项目文档(需求/设计/实施计划)
└── plugins/zcode-watch/                 ← 插件本体
    ├── .zcode-plugin/plugin.json
    ├── hooks/hooks.json                  ← SessionStart:拉起悬浮窗 + 满额注入提醒
    ├── commands/watch.md                 ← /zcode-watch:watch 命令
    └── skills/zcode-watch/
        ├── SKILL.md
        └── scripts/
            ├── zcode-watch.mjs          ← 查询引擎(零依赖,单份正本)
            ├── zcode-watch.test.mjs     ← 纯函数单测(node --test)
            ├── zcode-watch-widget.ps1   ← Windows 多卡片悬浮窗(纯 UI 壳)
            ├── widget-launch.mjs         ← 跨平台启动器(按平台分发)
            └── widget-launch.vbs         ← Windows 免黑窗启动器
```

运行期数据(不在仓库内):配置 `~/.zcode/zcode-watch.json`(人写)、缓存 `~/.zcode/zcode-watch-cache.json`(机器生成,勿手改)。

## 卸载

ZCode 设置 → 插件管理 → 已安装 → zcode-watch → 卸载。悬浮窗会随插件缓存被移除而自动退出,不残留开机自启或后台进程;`~/.zcode/zcode-watch*.json` 配置与缓存文件可手动删除。

## 更新日志

- **0.4.0**:新增 **macOS 原生悬浮窗**(ZCodeWatchHUD.app,Swift+AppKit 纯壳,多卡片布局与 Windows 版一致,菜单栏 ⚡ 兜底、位置记忆、node 多路径探测、默认快捷键 Ctrl+Shift+G 与 zcode-usage 共存);widget-launch.mjs 增加 darwin 分发(open -g 幂等唤起);.gitattributes 增加 swift LF 规则。Swift 代码需在 macOS 真机 `bash build.sh` 编译验证。
- **0.3.0**:数据源改为**账单明细**(费用账单-费用明细,分钟级),实现同账号多把 Key 各自独立的高峰/非高峰拆分(此前监控接口只能给账号级);增量同步采用水位线 + 缺口窗口(保底 2 小时、40 页触顶断点续拉),稳态每账号每次 1~2 请求;悬浮窗自动刷新改为 110 分钟,手动实时;峰时判定纯时间不看折扣比,token 口径只计 输入/输出/缓存命中。
- **0.2.0**:高峰/非高峰拆分改为**官方接口小时序列求和**(工作日 14:00–17:59 小时桶),彻底修复旧峰窗区间查询的两个缺陷:当天窗口在晚间会坍缩为全天总量(非高峰被计入高峰)、endTime 桶包含语义导致多算 18–19 点。取数改为滚动窗口(昨天→现在)+ 按天缓存:稳态 2 请求/Key,断档自动按 ≤7 天分段补齐,昨天整天自愈。判定基于服务端时间戳字符串,客户端时区无关。
- **0.1.1**:项目更名 chrome-watch → zcode-watch(目录/文件/命令/技能/互斥量/环境变量/配置路径全量),修复悬浮窗热键与 zcode-usage 冲突(Ctrl+Shift+G)。
- **0.1.0**:首个版本。多 Key 月度用量监控(加权:高峰×3 + 非高峰×1)、Windows 多卡片悬浮窗、满额三通道提醒、会话技能与 `/zcode-watch:watch` 命令、逐日高峰缓存(稳态 3 请求/Key/次)。

## License

MIT
