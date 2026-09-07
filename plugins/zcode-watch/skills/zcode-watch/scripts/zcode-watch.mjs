#!/usr/bin/env node
/**
 * zcode-watch —— 多把 GLM Coding Plan API Key 的自然月用量监控(零依赖,Node >= 18)
 *
 * 数据来源(与 zcode-usage 相同的智谱官方监控接口,不消耗 prompt 额度):
 *   GET {origin}/api/monitor/usage/quota/limit                    —— 套餐档位 level
 *   GET {origin}/api/monitor/usage/model-usage?startTime=&endTime= —— 区间用量 + 逐小时序列
 *   origin:bigmodel → https://open.bigmodel.cn;zai → https://api.z.ai
 *
 * 高峰/非高峰拆分(2026-09 实测结论,见 PROJECT.md §5):
 *   接口返回的 x_time/tokensUsage 小时序列是权威口径(求和与 totalUsage 分毫不差);
 *   高峰 = 工作日(周一至五)14:00–17:59 小时桶求和(左闭右开,18 点桶属非高峰)。
 *   不再用独立的峰窗区间查询——服务端对当天区间会把 endTime 截到当前时刻,
 *   晚间查询会把全天算进高峰;且区间 endTime 桶为包含语义,会把 18–19 点多算进去。
 *
 * 取数策略(滚动窗口 + 按天缓存):
 *   每次刷新查 [max(月初, 需要的最早日期 00:00) → 现在],按 ≤7 天分段保证小时粒度
 *   (跨度 ≥13 天会退化为天粒度,≥37 天直接报错);endTime 永远 ≤ 现在。
 *   过去的天写进按天缓存 {tokens, peak};今天只实时显示不落盘。
 *   fetchFrom 取「第一个缺失的过去日」与「昨天」的较早者:
 *   - 稳态 = [昨天 00:00 → 现在] 单请求(昨天整天顺路带回,服务端微调可自愈);
 *   - 断档后首刷自动分段补齐缺口(≤5 个请求/Key,一次性)。
 *   稳态请求预算:每 Key 每次 2 个(档位 + 滚动窗口)。
 *
 * 配置:~/.zcode/zcode-watch.json(手动 / 会话内助手维护,格式见 README)
 * 缓存:~/.zcode/zcode-watch-cache.json(机器生成:按天结算值 + lastResult,勿手改)
 *
 * 月度口径:自然月(当月 1 日 00:00 本地时间起,每月 1 号自动重置);
 * 加权总量 = 非高峰×1 + 高峰×3。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const asHook = argv.includes('--hook');

// ---------- 常量 ----------
export const DEFAULT_MONTHLY_QUOTA = 1750000000; // 17.5 亿加权 token
export const PEAK_HOURS = [14, 15, 16, 17]; // 高峰 = 工作日 14:00–17:59 的小时桶
const CHUNK_MAX_DAYS = 7; // 单段最大跨度:≥13 天接口会退化为天粒度,7 天留足余量
const PROVIDER_ORIGIN = {
  bigmodel: 'https://open.bigmodel.cn',
  zai: 'https://api.z.ai',
};
const CONFIG_FILE = path.join(os.homedir(), '.zcode', 'zcode-watch.json');
const CACHE_FILE = path.join(os.homedir(), '.zcode', 'zcode-watch-cache.json');
const FETCH_TIMEOUT = 10000;
const HOOK_FETCH_TIMEOUT = 5000;
const LAST_RESULT_FRESH_MS = 60 * 60 * 1000; // hook 注入可接受的 lastResult 新鲜度

// ---------- 纯函数(export 供 zcode-watch.test.mjs 单测) ----------
const z2 = (n) => String(n).padStart(2, '0');
export const monthKeyOf = (d) => `${d.getFullYear()}-${z2(d.getMonth() + 1)}`;
export const dayKeyOf = (d) => `${monthKeyOf(d)}-${z2(d.getDate())}`;
export function monthStartOf(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function nextMonthStartOf(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
export const fmtDateTime = (d) => `${dayKeyOf(d)} ${z2(d.getHours())}:${z2(d.getMinutes())}:${z2(d.getSeconds())}`;

/** 解析序列桶标签。小时标签 '2026-09-07 14:00' → {date, hour};天标签 '2026-09-07' → hour=null。
 *  纯字符串切片:x_time 是服务端北京时间字符串,不经过 Date 解析,客户端时区无关。 */
export function parseBucketLabel(label) {
  const s = String(label || '');
  const date = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date: s, hour: null };
  const hour = s.length >= 13 ? Number(s.slice(11, 13)) : NaN;
  return { date, hour: Number.isFinite(hour) ? hour : null };
}

/** 由 'YYYY-MM-DD' 算星期(0=周日)。走 Date.UTC,不吃本机时区。 */
export function weekdayOfDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 高峰桶判定:工作日 14:00–17:59(18 点桶 = 18:00–19:00,属非高峰) */
export function isPeakBucket(dateStr, hour) {
  if (hour === null || hour === undefined) return false;
  const dow = weekdayOfDateStr(dateStr);
  return dow >= 1 && dow <= 5 && PEAK_HOURS.includes(hour);
}

/** 小时序列按天聚合:{ 'YYYY-MM-DD': { tokens, peak, calls } };天粒度标签抛错 */
export function splitSeriesByDay(xTime, tokensUsage, modelCallCount) {
  const days = {};
  (xTime || []).forEach((label, i) => {
    const { date, hour } = parseBucketLabel(label);
    if (hour === null) throw new Error(`接口返回非小时粒度(${label}),无法拆分高峰`);
    const t = Number(tokensUsage?.[i]) || 0;
    const c = Number(modelCallCount?.[i]) || 0;
    const agg = (days[date] = days[date] || { tokens: 0, peak: 0, calls: 0 });
    agg.tokens += t;
    agg.calls += c;
    if (isPeakBucket(date, hour)) agg.peak += t;
  });
  return days;
}

/**
 * 取数分段:[fetchFrom(某日 00:00), now] 切成 ≤7 天的段。
 * 相邻段边界用 23:59:59 —— 接口的 endTime 桶是包含语义,
 * 若下一段从上段 endTime 的整点起,交界处那个小时桶会被两段重复计入。
 * now 恰好落在边界上时不产生零宽末段。
 */
export function chunkFetchRanges(fetchFrom, now, maxDays = CHUNK_MAX_DAYS) {
  const DAY = 86400000, SEC = 1000;
  const ranges = [];
  let start = new Date(fetchFrom);
  while (start.getTime() < now.getTime()) {
    const hardEnd = start.getTime() + maxDays * DAY; // 下一段起点(整点)
    const end = hardEnd <= now.getTime() ? new Date(hardEnd - SEC) : new Date(now.getTime());
    ranges.push({ start: new Date(start), end });
    start = new Date(hardEnd);
  }
  return ranges;
}

/** 总使用额度(加权)= 非高峰×1 + 高峰×3 */
export const weightedOf = (offPeak, peak) => offPeak + peak * 3;

/** 配置解析:剥 BOM、容忍 CRLF、缺省字段给默认值;结构不对抛带指引的错误 */
export function parseConfig(text) {
  let obj;
  try {
    obj = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`配置文件不是合法 JSON:${CONFIG_FILE}`);
  }
  if (!obj || !Array.isArray(obj.keys)) {
    throw new Error(`配置文件缺少 "keys" 数组:${CONFIG_FILE}(格式见 README)`);
  }
  const keys = obj.keys.map((k, i) => {
    const apiKey = typeof k?.apiKey === 'string' ? k.apiKey.trim() : '';
    if (!apiKey) throw new Error(`第 ${i + 1} 个 Key 缺少 apiKey 字段(${CONFIG_FILE})`);
    return {
      id: typeof k.id === 'string' && k.id.trim() ? k.id.trim() : `key-${i + 1}`,
      name: typeof k.name === 'string' && k.name.trim() ? k.name.trim() : `Key ${i + 1}`,
      provider: k.provider === 'zai' ? 'zai' : 'bigmodel',
      apiKey,
      monthlyQuota: Number(k.monthlyQuota) > 0 ? Number(k.monthlyQuota) : DEFAULT_MONTHLY_QUOTA,
    };
  });
  return { keys };
}

/** 缓存月份不匹配(进入新自然月)→ 整体清空:月度重置的实现点 */
export function resetCacheIfStale(cache, monthKey) {
  if (cache.month !== monthKey) {
    return { version: 2, month: monthKey, days: {}, lastResult: null };
  }
  return cache;
}

/** token 数值显示:亿(2 位小数)/ 万(1 位小数)/ 千分位 */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return v.toLocaleString('zh-CN');
}

/** Key 脱敏:只露尾号 4 位 */
export function maskKey(key) {
  const k = String(key || '');
  return k.length <= 4 ? '····' : '····' + k.slice(-4);
}

/** 距离下月 1 号还剩几天(向上取整;当天重置返回下月计数) */
export function daysUntilReset(now) {
  return Math.max(0, Math.ceil((nextMonthStartOf(now).getTime() - now.getTime()) / 86400000));
}

// ---------- 配置与缓存 IO(防御性解析:剥 BOM、坏文件当不存在) ----------
function readTextDefensive(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function loadConfig() {
  const text = readTextDefensive(CONFIG_FILE);
  if (text === null || !text.trim()) return { keys: [], missing: true };
  return parseConfig(text); // 结构错误向上抛,由调用方决定怎么呈现
}

function loadCache(monthKey) {
  let cache = null;
  const text = readTextDefensive(CACHE_FILE);
  if (text) {
    try { cache = JSON.parse(text); } catch { /* 坏缓存当不存在 */ }
  }
  if (!cache || typeof cache !== 'object' || cache.version !== 2) {
    cache = { version: 2, month: monthKey, days: {}, lastResult: null };
  }
  cache = resetCacheIfStale(cache, monthKey);
  cache.days = cache.days && typeof cache.days === 'object' ? cache.days : {};
  return cache;
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch { /* 缓存写失败不影响本次输出 */ }
}

// ---------- 请求层(Authorization 头,401 时 Bearer 重试一次,与 zcode-usage 相同) ----------
function makeGet(origin, token, timeoutMs) {
  let tok = token;
  let bearerTried = false;
  return async function get(p) {
    let res;
    try {
      res = await fetch(origin + p, {
        headers: {
          Authorization: tok,
          'Accept-Language': 'zh-CN,zh',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `请求超时(${timeoutMs / 1000}s):${origin} 无响应,请检查网络`
        : `网络错误,无法连接 ${origin}:${e.message}`);
    }
    if (res.status === 401 && !bearerTried && !tok.startsWith('Bearer ')) {
      bearerTried = true;
      tok = `Bearer ${tok}`;
      return get(p);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== undefined && body.code !== 200 && body.code !== 0) {
      throw new Error(String(body.msg || body.code));
    }
    return body.data ?? body;
  };
}

const usageQs = (start, end) =>
  `?startTime=${encodeURIComponent(fmtDateTime(start))}&endTime=${encodeURIComponent(fmtDateTime(end))}`;

/** 取一段区间的逐小时序列并按天聚合;分段查询失败向上抛(该 Key 记 error,下次重试) */
async function fetchSeriesDays(get, start, end) {
  const d = await get('/api/monitor/usage/model-usage' + usageQs(start, end));
  if (String(d?.granularity) !== 'hourly' || !Array.isArray(d?.x_time)) {
    throw new Error(`接口返回粒度异常(granularity=${d?.granularity ?? '无'}),无法拆分高峰`);
  }
  return splitSeriesByDay(d.x_time, d.tokensUsage, d.modelCallCount);
}

/**
 * 单 Key 查询:档位 + 滚动窗口序列。
 * fetchFrom = 「第一个缺失的过去日」与「昨天」的较早者(都不存在则昨天),
 * 保证稳态单请求、昨天整天可自愈、断档自动补齐。
 */
async function queryKey(k, now, cache, timeoutMs) {
  const origin = PROVIDER_ORIGIN[k.provider];
  const get = makeGet(origin, k.apiKey, timeoutMs);
  const r = {
    id: k.id,
    name: k.name,
    provider: k.provider,
    keyTail: maskKey(k.apiKey),
    level: '',
    monthTokens: 0,
    peakTokens: 0,
    offPeakTokens: 0,
    weightedTotal: 0,
    monthlyQuota: k.monthlyQuota,
    percent: 0,
    exhausted: false,
    resetDate: dayKeyOf(nextMonthStartOf(now)),
    error: null,
  };

  let quota;
  try {
    quota = await get('/api/monitor/usage/quota/limit');
  } catch (e) {
    r.error = e.message;
    return r;
  }
  r.level = String(quota?.level || '').toUpperCase() || '未知';

  // 计算取数起点
  const today = dayKeyOf(now);
  const monthStart = monthStartOf(now);
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const keyDays = cache.days[k.id] || {};
  let fetchFrom = yesterdayStart;
  for (let d = new Date(monthStart); dayKeyOf(d) < today; d.setDate(d.getDate() + 1)) {
    if (!keyDays[dayKeyOf(d)]) { fetchFrom = new Date(d); break; } // 第一个缺失的过去日(含断档空洞)
  }
  if (fetchFrom.getTime() < monthStart.getTime()) fetchFrom = new Date(monthStart); // 月初 1 号:不回看上月

  let fetched;
  try {
    const merged = {};
    for (const range of chunkFetchRanges(fetchFrom, now)) {
      const part = await fetchSeriesDays(get, range.start, range.end);
      Object.assign(merged, part); // 分段不重叠(边界 23:59:59),直接合并
    }
    fetched = merged;
  } catch (e) {
    r.error = e.message;
    return r;
  }

  // 结算:过去的天写缓存;今天的只作实时值
  const todayAgg = fetched[today] || { tokens: 0, peak: 0, calls: 0 };
  const days = { ...keyDays };
  for (const [day, v] of Object.entries(fetched)) {
    if (day < today) days[day] = { tokens: v.tokens, peak: v.peak };
  }
  cache.days[k.id] = days;

  let monthTokens = todayAgg.tokens;
  let peakTokens = todayAgg.peak;
  for (const v of Object.values(days)) {
    monthTokens += v.tokens;
    peakTokens += v.peak;
  }
  r.monthTokens = monthTokens;
  r.peakTokens = peakTokens;
  r.offPeakTokens = Math.max(0, monthTokens - peakTokens);
  r.weightedTotal = weightedOf(r.offPeakTokens, r.peakTokens);
  r.percent = k.monthlyQuota > 0 ? (r.weightedTotal / k.monthlyQuota) * 100 : 0;
  r.exhausted = r.percent >= 100;
  return r;
}

// ---------- 主查询:并行所有 Key,更新缓存与 lastResult ----------
async function runQuery(timeoutMs = FETCH_TIMEOUT) {
  const now = new Date();
  const cfg = loadConfig();
  if (cfg.missing || !cfg.keys.length) {
    return { empty: true, month: monthKeyOf(now), fetchedAt: now.getTime(), keys: [] };
  }
  const cache = loadCache(monthKeyOf(now));
  // 清理已删除 Key 的缓存条目
  const ids = new Set(cfg.keys.map((k) => k.id));
  for (const id of Object.keys(cache.days)) {
    if (!ids.has(id)) delete cache.days[id];
  }
  const keys = await Promise.all(cfg.keys.map((k) => queryKey(k, now, cache, timeoutMs)));
  const payload = { month: monthKeyOf(now), fetchedAt: now.getTime(), keys };
  cache.lastResult = { ts: payload.fetchedAt, month: payload.month, keys: payload.keys };
  saveCache(cache);
  return payload;
}

// ---------- 终端着色与排版(仅在真终端且支持 ANSI 时;管道/重定向输出纯文本) ----------
const supportsAnsi = process.platform !== 'win32'
  || !!process.env.TERM
  || !!process.env.WT_SESSION
  || process.env.ConEmuANSI === 'ON';
const useColor = !process.env.NO_COLOR && process.stdout.isTTY && supportsAnsi;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const rateStyle = (p) => (p >= 85 ? '1;31' : p >= 60 ? '33' : '32');

// 显示宽度:中日韩全角按 2 列计
function dw(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
const padEndW = (s, width) => s + ' '.repeat(Math.max(0, width - dw(s)));

function bar(pct, width = 18) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  return c(rateStyle(p), '▰'.repeat(filled) + '▱'.repeat(width - filled))
    + '  ' + c(rateStyle(p), `已用 ${Number(pct).toFixed(1)}%`);
}

const LABEL_W = 14; // 三行额度的标签列显示宽度
const rule = (ch) => c('2;36', ch.repeat(50));

function renderKeyCard(k, now) {
  const lines = [];
  const head = ` ● ${k.name} ${k.keyTail} · [${k.level || '?'}] · ${k.provider}`;
  lines.push(k.exhausted ? c('1;31', head) : bold(head));
  if (k.error) {
    lines.push(`   ${c('1;31', '⚠ 查询失败:' + k.error)}`);
    const badKey = /401|令牌|token|鉴权|验证/i.test(k.error);
    lines.push(dim(`     ${badKey ? 'Key 无效或非 Coding Plan 专用 Key,请检查 ' + CONFIG_FILE : '稍后重试;持续失败请检查网络与配置'}`));
    return lines.join('\n');
  }
  if (k.exhausted) {
    lines.push(`   ${c('1;31', '⚠ 本月已用满 100%,建议删除该 Key')}`);
  }
  lines.push(`   ${bar(k.percent)}`);
  lines.push(`   ${padEndW('总使用额度', LABEL_W)}${fmtTokens(k.weightedTotal)} / ${fmtTokens(k.monthlyQuota)}`);
  lines.push(`   ${padEndW('高峰期使用', LABEL_W)}${fmtTokens(k.peakTokens)}(×3 折算)`);
  lines.push(`   ${padEndW('非高峰期使用', LABEL_W)}${fmtTokens(k.offPeakTokens)}`);
  lines.push(dim(`   ↻ ${k.resetDate} 重置 · 还剩 ${daysUntilReset(now)} 天 · 总额度 = 非高峰×1 + 高峰×3`));
  return lines.join('\n');
}

function renderEmpty() {
  return [
    '未配置任何 API Key。添加方式(二选一):',
    '  1. 在 ZCode 对话里说:「添加一个 zcode-watch key,名字 xx,Key 是 xxx」',
    `  2. 手动编辑 ${CONFIG_FILE},格式:`,
    '     { "keys": [ { "id": "key-1", "name": "主力", "provider": "bigmodel",',
    '                   "apiKey": "你的Key", "monthlyQuota": 1750000000 } ] }',
    '     provider:bigmodel(智谱开放平台)| zai(智谱国际);monthlyQuota 缺省 17.5 亿',
  ].join('\n');
}

// ---------- CLI 入口 ----------
async function main() {
  const now = new Date();

  // SessionStart hook:读 lastResult(≤60 分钟新鲜)判断满额,零请求;过期降级实查(5s 超时)
  if (asHook) {
    let payload = null;
    try {
      const cached = loadCache(monthKeyOf(now)).lastResult;
      if (cached && cached.month === monthKeyOf(now)
        && Array.isArray(cached.keys)
        && Date.now() - cached.ts < LAST_RESULT_FRESH_MS) {
        payload = cached;
      } else {
        payload = await runQuery(HOOK_FETCH_TIMEOUT);
      }
    } catch { /* hook 失败静默,不阻塞会话启动 */ }
    const exhausted = (payload?.keys || []).filter((k) => !k.error && k.exhausted);
    const line = exhausted.length
      ? `【zcode-watch】⚠ ${exhausted.length} 把 Key 本月已用满 100%,建议删除:${exhausted.map((k) => `「${k.name} ${k.keyTail}」`).join(' ')}`
      : '';
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
    }));
    return;
  }

  let payload;
  try {
    payload = await runQuery();
  } catch (e) {
    // 配置文件损坏等致命错误:--json 也要给悬浮窗可解析的输出
    if (asJson) {
      console.log(JSON.stringify({ month: monthKeyOf(now), fetchedAt: Date.now(), keys: [], error: e.message }));
      return;
    }
    console.error('查询失败:', e.message);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.empty) {
    console.log(renderEmpty());
    return;
  }

  const ok = payload.keys.filter((k) => !k.error).length;
  console.log(rule('━'));
  console.log(bold(` ⚡ zcode-watch · ${payload.month} 月度用量 · ${payload.keys.length} 把 Key(${ok} 把正常)`));
  console.log(dim(`    ${now.toLocaleString('zh-CN')} · 加 --json 看原始数据`));
  for (const k of payload.keys) {
    console.log('');
    console.log(renderKeyCard(k, now));
  }
  console.log('');
  console.log(rule('━'));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error('查询失败:', e.message);
    process.exit(1);
  });
}
