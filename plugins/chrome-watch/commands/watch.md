---
description: 查询多把 GLM Coding Plan API Key 的自然月用量(高峰×3+非高峰×1 加权)与满额提醒
allowed-tools: Bash, Read
---

# chrome-watch 多 Key 月度用量

使用 Skill 工具调用 `chrome-watch:chrome-watch` 技能执行一次查询(如技能不可用,按技能文档直接运行其 scripts/chrome-watch.mjs 脚本)。

## 汇报要求

把输出整理成简洁的中文表格,每把 Key 一行或多行,必须包含:

1. **档位**(如 LITE / PRO / MAX)
2. **进度**:已用百分比(总使用额度 ÷ 月度总额度)
3. **三项额度**:总使用额度(加权)、高峰期使用额度、非高峰期使用额度
4. **重置**:下月 1 号,还剩几天

## 关键约束

- **只执行一次查询**,无论成功失败,立即返回结果,不要重试
- 不要改写或猜测数字,一切以脚本输出为准
- **已用满 100%(exhausted)的 Key,明确建议用户删除**
- 失败时原样展示错误信息,并提示检查 `~/.zcode/chrome-watch.json` 中的 apiKey;Key 的添加/删除可直接在对话里完成(技能文档有代管说明)
