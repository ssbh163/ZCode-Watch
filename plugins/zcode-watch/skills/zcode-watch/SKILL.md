---
name: zcode-watch
description: 查询多把 GLM Coding Plan API Key 的自然月用量(加权口径:高峰×3 + 非高峰×1)、进度条与满额删除提醒;也可按用户指示在 ~/.zcode/zcode-watch.json 中增删改 Key。当用户询问某把 Key 的月度用量、还剩多少额度、哪把该删、如何添加/删除 Key 时使用。
allowed-tools: Bash, Read, Edit
---

# zcode-watch 多 Key 月度用量查询

执行本技能自带脚本(相对本技能的 base directory,即文末注入的路径):

```bash
node scripts/zcode-watch.mjs
```

若工作目录不在技能目录,使用绝对路径运行 `<base-directory>/scripts/zcode-watch.mjs`;Windows Git Bash 下也可用 glob 定位:

```bash
node "$(ls -d "$HOME/.zcode/cli/plugins/cache"/*/zcode-watch/*/skills/zcode-watch/scripts/zcode-watch.mjs 2>/dev/null | sort -V | tail -1)"
```

## 关键约束

- **只执行一次查询**,无论成功失败立即返回结果,不要重试
- 成功:整理成中文表格或卡片汇报,每把 Key 必须包含:档位、已用百分比、总使用额度 / 总额度、高峰期使用额度、非高峰期使用额度、重置日期
- **对 exhausted(已用满 100%)的 Key,明确建议用户删除该 Key**
- 失败:原样展示该 Key 的错误;提示用户检查 `~/.zcode/zcode-watch.json` 中的 apiKey
- 需要原始 JSON 时,运行同一命令并加 `--json` 参数
- 不要改写或猜测数字,一切以脚本输出为准

## Key 管理(助手代管)

配置文件:`~/.zcode/zcode-watch.json`(Windows 为 `%USERPROFILE%\.zcode\zcode-watch.json`),格式:

```json
{
  "keys": [
    {
      "id": "key-1",
      "name": "主力",
      "provider": "bigmodel",
      "apiKey": "xxxxxxxx",
      "monthlyQuota": 1750000000
    }
  ]
}
```

按用户指示增删改时遵守:

- **改前必须先 Read 完整配置文件**(文件可能不存在,不存在则新建),编辑时保持原有缩进与字段顺序
- `provider`:`bigmodel`(智谱开放平台,默认)| `zai`(智谱国际)
- `monthlyQuota`:该 Key 的月度总额度(加权 token),用户未提供时**不写该字段**(引擎按 17.5 亿缺省)
- `id`:唯一且不复用;新增时取现有最大 `key-N` 的 N+1
- `name`:用户指定的称呼,未指定用 `Key N`
- 删除某把 Key = 移除该对象(缓存条目引擎会自动清理)
- **安全:不要把完整 apiKey 回显到对话输出里**,提及时只说尾号(如 ····abcd);不要把 Key 写进命令行参数或日志

## 口径说明(向用户解释时使用)

- 总使用额度 = 非高峰期 token ×1 + 高峰期 token ×3(高峰期 = 工作日 14:00–18:00)
- 月度周期为自然月,每月 1 号自动重置,从当月 1 日 00:00 起累计
- 进度条百分比 = 总使用额度 ÷ monthlyQuota
