#!/usr/bin/env node
/**
 * zcode-watch —— 多把 GLM Coding Plan API Key 的自然月用量监控(零依赖,Node >= 18)
 *
 * 数据来源(v0.3.0,设计详见 PROJECT.md §5):
 *   GET https://bigmodel.cn/api/finance/expenseBill/expenseBillList?billingMonth=&pageNum=&pageSize=
 *     按分钟用量明细:每行 = Key × 分钟窗 × 模型 × tokenType;API Key 直接认证;
 *     账号级(返回该账号全部 Key 的行);行按时间倒序分页
 *   GET {origin}/api/monitor/usage/quota/limit —— 套餐档位(账号级,缓存 1 小时)
 *
 * 统计口径:每把 Key 独立;高峰 = 工作日(周一至五)14:00–17:59 的分钟窗(纯时间判定,
 * 不读 deductScale);token 只计 输入/输出/缓存命中;加权总量 = 非高峰×1 + 高峰×3;
 * 月度 = billingMonth 自然月,每月 1 号重置。
 *
 * 增量同步(水位线 + 缺口窗口):
 *   窗口 = max(2h, gap 向上取整到小时);pullStart 向下取整到整点并 clamp 到月初/backlog;
 *   翻页遇早于 pullStart 的行即停;≥ pullStart 的小时桶整桶覆盖重算(幂等,自愈延迟入库行);
 *   watermark 仅在整轮成功后推进;40 页触顶时推进到已覆盖最早整点并记 backlogUntil 续拉。
 *
 * 账号关联(v0.5.0,缓存 v4):主键 = apiKey 段(Key 的稳定身份),keyAccount 记 段→账号;
 *   段无映射的新 Key 走「发现流程」——拿这把 Key 自己认证全量拉取,行内 customerId 即真实账号,
 *   不继承任何旧关联。v3 及更早按「配置 key id」关联,id 会被默认命名复用(删旧加新后 key-1
 *   不再是原来那把 Key),曾导致新 Key 错挂旧账号、跨账号污染与全月历史缺失;迁移时保留账号
 *   数据、丢弃 id 键控关联,由发现流程重建。
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
export const MIN_WINDOW_HOURS = 2;               // 保底拉取窗口(小时)
export const PAGE_SIZE = 500;                    // 明细分页大小
export const MAX_PAGES = 40;                     // 翻页上限(防失控),触顶走 backlog 续拉
export const LEVEL_TTL_MS = 3600_000;            // 档位缓存时长
const HOUR_MS = 3600_000;
const TOKEN_TYPES = new Set(['输入', '输出', '缓存命中']); // 工具行(按次计)不计 token
const PROVIDER_ORIGIN = {
  bigmodel: 'https://open.bigmodel.cn',
  zai: 'https://api.z.ai',
};
const FINANCE_ORIGIN = {
  bigmodel: 'https://bigmodel.cn',
  zai: 'https://api.z.ai', // 未验证,失败自动降级为错误卡
};
const CONFIG_FILE = path.join(os.homedir(), '.zcode', 'zcode-watch.json');
const CACHE_FILE = path.join(os.homedir(), '.zcode', 'zcode-watch-cache.json');
const FETCH_TIMEOUT = 20000;         // 明细分页可能较大
const HOOK_FETCH_TIMEOUT = 5000;
const LAST_RESULT_FRESH_MS = 60 * 60 * 1000;

// ---------- 纯函数(export 供 zcode-watch.test.mjs 单测) ----------
const z2 = (n) => String(n).padStart(2, '0');
export const monthKeyOf = (d) => `${d.getFullYear()}-${z2(d.getMonth() + 1)}`;
export const dayKeyOf = (d) => `${monthKeyOf(d)}-${z2(d.getDate())}`;
export function nextMonthStartOf(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }

/** 北京时间整月起点(账单月与统计月对应) */
export const monthStartMsOf = (monthKey) => Date.parse(`${monthKey}-01 00:00:00+08:00`);

/** epoch(ms)→ 北京时间小时桶标签 'YYYY-MM-DD HH'(UTC+8 为整小时偏移,epoch 整点即北京整点) */
export function hourKeyOfMs(ms) {
  const d = new Date(ms + 8 * HOUR_MS);
  return `${d.getUTCFullYear()}-${z2(d.getUTCMonth() + 1)}-${z2(d.getUTCDate())} ${z2(d.getUTCHours())}`;
}
const floorToHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * 解析账单时间字符串(服务端北京时间,月/日/时可能不补零)。
 * 输出 date 'YYYY-MM-DD'、hourKey 'YYYY-MM-DD HH'、minuteOfDay、ms(按 +08:00 折算的真实时刻)。
 * 纯字符串切片,与本机时区无关;畸形返回 null。
 */
export function parseBillTime(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, da, h, mi, se] = m;
  const date = `${y}-${z2(mo)}-${z2(da)}`;
  const hh = z2(h), mm = z2(mi), ss = z2(se || '0');
  const ms = Date.parse(`${date}T${hh}:${mm}:${ss}+08:00`);
  if (!Number.isFinite(ms)) return null;
  return {
    date,
    hourKey: `${date} ${hh}`,
    minuteOfDay: Number(h) * 60 + Number(mi),
    ms,
  };
}

/** 取账单 timeWindow 左侧(起始时刻):'2026-09-08 11:25:00~2026-09-08 11:26:00' → parseBillTime(左) */
export function parseTimeWindowStart(timeWindow) {
  const s = String(timeWindow || '').split('~')[0];
  return parseBillTime(s);
}

/** 由 'YYYY-MM-DD' 算星期(0=周日),走 Date.UTC 不吃本机时区 */
export function weekdayOfDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 高峰分钟判定:工作日 14:00–17:59(左闭右开,18:00 起非高峰;纯时间,不看折扣比) */
export function isPeakMinute(dateStr, minuteOfDay) {
  const dow = weekdayOfDateStr(dateStr);
  if (dow < 1 || dow > 5) return false;
  return minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60;
}

/** 配置 Key(完整 `id.secret`)→ 账单 apiKey 段(第一个点号前);无点号整串兜底 */
export function keyIdSegmentOf(apiKey) {
  const k = String(apiKey || '').trim();
  const i = k.indexOf('.');
  return i > 0 ? k.slice(0, i) : k;
}

/**
 * 明细行聚合 → { [apiKey段]: { [小时桶]: { tokens, peak } } }
 * 只计 tokenType ∈ 输入/输出/缓存命中;畸形时间窗跳过。
 * 聚合保留账号内全部 Key 段(含未配置的)——后续向同账号添加新 Key 时直接命中历史;
 * 展示层只按配置 Key 取数。
 */
export function aggregateRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const seg = keyIdSegmentOf(r?.apiKey);
    if (!seg) continue;
    if (!TOKEN_TYPES.has(r?.tokenType)) continue;
    const t = parseTimeWindowStart(r?.timeWindow);
    if (!t) continue;
    const usage = Number(r?.usageCount) || 0;
    const agg = (out[seg] = out[seg] || {});
    const b = (agg[t.hourKey] = agg[t.hourKey] || { tokens: 0, peak: 0 });
    b.tokens += usage;
    if (isPeakMinute(t.date, t.minuteOfDay)) b.peak += usage;
  }
  return out;
}

/**
 * 缺口窗口计算:window = max(2h, gap 向上取整到小时);start = now−window 向下取整到整点,
 * 再 min(backlogUntil)、max(当月 1 日 00:00)。gap ≤ 0(时钟回拨)按保底 2h。
 */
export function computePullStart(watermarkMs, nowMs, backlogMs, monthStartMs) {
  const gapMs = watermarkMs == null ? Infinity : nowMs - watermarkMs;
  const windowHours = gapMs === Infinity ? Infinity : Math.max(MIN_WINDOW_HOURS, Math.ceil(gapMs / HOUR_MS));
  let startMs = gapMs === Infinity ? monthStartMs : floorToHour(nowMs - windowHours * HOUR_MS);
  if (backlogMs != null) startMs = Math.min(startMs, floorToHour(backlogMs));
  startMs = Math.max(startMs, monthStartMs);
  return { startMs, gapMs, windowHours };
}

/**
 * 小时桶覆盖合并:hourKey ≥ startHourKey 的桶以 fresh 为准(不在 fresh 即视为 0,删除);
 * < startHourKey 的桶保持不动(固化区)。segs 独立处理。
 */
export function mergeBuckets(settled, fresh, startHourKey) {
  const out = {};
  const segs = new Set([...Object.keys(settled || {}), ...Object.keys(fresh || {})]);
  for (const seg of segs) {
    const s = settled?.[seg] || {};
    const f = fresh?.[seg] || {};
    const merged = {};
    for (const [hour, v] of Object.entries(s)) {
      if (hour < startHourKey) merged[hour] = v;
    }
    for (const [hour, v] of Object.entries(f)) {
      if (hour >= startHourKey) merged[hour] = v;
    }
    if (Object.keys(merged).length) out[seg] = merged;
  }
  return out;
}

/** 缓存月份不匹配(进入新自然月)→ 整体重置:月度重置的实现点 */
export function resetCacheIfStale(cache, monthKey) {
  if (cache.month !== monthKey) {
    return { version: 4, month: monthKey, accounts: {}, keyAccount: {}, lastResult: null };
  }
  return cache;
}

/**
 * 旧缓存迁移(v0.5.0):账号数据(settled/watermark/档位)按 customerId 键控,仍然有效全部保留;
 * v3 的 keyAccount(配置 key id → 账号)、authKeyId、keyMap 均为 id 键控,换 Key 复用 id 时不可信,
 * 一律丢弃,由下一轮发现流程(拿 Key 自己认证,行内 customerId 权威定账号)重建。
 */
export function migrateCache(cache) {
  if (!cache || typeof cache !== 'object') {
    return { version: 4, month: null, accounts: {}, keyAccount: {}, lastResult: null };
  }
  if (cache.version === 4) return cache;
  const accounts = {};
  for (const [cid, s] of Object.entries(cache.accounts || {})) {
    if (!s || typeof s !== 'object') continue;
    accounts[cid] = {
      settled: s.settled && typeof s.settled === 'object' ? s.settled : {},
      watermark: typeof s.watermark === 'number' ? s.watermark : null,
      backlogUntil: typeof s.backlogUntil === 'number' ? s.backlogUntil : null,
      level: typeof s.level === 'string' ? s.level : null,
      levelAt: typeof s.levelAt === 'number' ? s.levelAt : null,
    };
  }
  return {
    version: 4,
    month: typeof cache.month === 'string' ? cache.month : null,
    accounts,
    keyAccount: {},
    lastResult: cache.lastResult ?? null,
  };
}

/**
 * 同步计划(纯函数):
 *   syncList     每个已知账号一条 { cid, key }(代表拉取的配置 Key,取配置顺序第一把;同账号多 Key 去重)
 *   discoverList 段无映射(新 Key)或映射悬空(指向不存在账号)的配置 Key —— 走发现流程
 * 关键不变量:段是身份、id 只是显示名。新 Key 即使复用了旧 id,段不同 → 进 discoverList,
 * 绝不继承旧 Key 的账号(修复 v0.4.0 及更早的跨账号错挂)。
 */
export function buildSyncPlan(keys, keyAccount, accounts) {
  const seen = new Set();
  const syncList = [];
  const discoverList = [];
  for (const k of keys || []) {
    const seg = keyIdSegmentOf(k.apiKey);
    const cid = keyAccount?.[seg];
    if (!cid || !(cid in (accounts || {}))) { discoverList.push(k); continue; }
    if (seen.has(cid)) continue;
    seen.add(cid);
    syncList.push({ cid, key: k });
  }
  return { syncList, discoverList };
}

/**
 * 收尾清理(纯函数,每轮保存前执行):
 *   1) keyAccount 只保留当前配置 Key 的段(已删 Key 的映射清除);
 *   2) accounts 只保留仍被引用的账号组(旧 Key 的孤儿账号连同 settled 一并清除);
 *   3) 去污染:某段的正主账号确定后,把该段从其他账号的 settled 里删除
 *      (历史跨账号错合并的残留;正常流程不会产生,迁移旧污染缓存时兜底)。
 */
export function pruneCache(cache, keys) {
  const segs = new Set((keys || []).map((k) => keyIdSegmentOf(k.apiKey)));
  const keyAccount = {};
  for (const [seg, cid] of Object.entries(cache.keyAccount || {})) {
    if (segs.has(seg)) keyAccount[seg] = cid;
  }
  const used = new Set(Object.values(keyAccount));
  const accounts = {};
  for (const [cid, s] of Object.entries(cache.accounts || {})) {
    if (used.has(cid)) accounts[cid] = s;
  }
  for (const [seg, cid] of Object.entries(keyAccount)) {
    for (const [ocid, s] of Object.entries(accounts)) {
      if (ocid !== cid && s?.settled && seg in s.settled) delete s.settled[seg];
    }
  }
  cache.keyAccount = keyAccount;
  cache.accounts = accounts;
  return cache;
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
  return parseConfig(text);
}

function loadCache(monthKey) {
  let cache = null;
  const text = readTextDefensive(CACHE_FILE);
  if (text) {
    try { cache = JSON.parse(text); } catch { /* 坏缓存当不存在 */ }
  }
  cache = migrateCache(cache); // v3 → v4(丢弃 id 键控关联);null/坏文件 → 空 v4
  cache = resetCacheIfStale(cache, monthKey);
  if (!cache.accounts || typeof cache.accounts !== 'object') cache.accounts = {};
  if (!cache.keyAccount || typeof cache.keyAccount !== 'object') cache.keyAccount = {};
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

/** 拉一页账单明细(倒序,最新在前) */
async function fetchBillPage(get, monthKey, pageNum) {
  const d = await get(`/api/finance/expenseBill/expenseBillList?billingMonth=${monthKey}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`);
  const rows = d?.rows;
  if (!Array.isArray(rows)) throw new Error('账单明细返回结构异常(无 rows)');
  return rows;
}

/**
 * 单账号同步:按缺口窗口翻页拉取 → 本地聚合 → 小时桶覆盖合并 → 推进水位线。
 * 失败向上抛(该账号本轮作废,watermark 不推进,下轮窗口自动覆盖)。
 * 返回 { customerId, pages, incomplete, seenSegs }。
 */
async function syncAccount(configKey, state, monthKey, nowMs, timeoutMs) {
  const origin = FINANCE_ORIGIN[configKey.provider];
  const get = makeGet(origin, configKey.apiKey, timeoutMs);
  const monthStartMs = monthStartMsOf(monthKey);
  const { startMs } = computePullStart(
    typeof state.watermark === 'number' ? state.watermark : null,
    nowMs,
    typeof state.backlogUntil === 'number' ? state.backlogUntil : null,
    monthStartMs,
  );

  const pulled = [];
  let pages = 0;
  let reachedFloor = false;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const rows = await fetchBillPage(get, monthKey, p);
    pages = p;
    if (!rows.length) { reachedFloor = true; break; }
    pulled.push(...rows);
    const oldest = parseTimeWindowStart(rows[rows.length - 1]?.timeWindow);
    if (oldest && oldest.ms < startMs) { reachedFloor = true; break; }
    if (rows.length < PAGE_SIZE) { reachedFloor = true; break; } // 末页
  }
  const incomplete = !reachedFloor;

  const validRows = [];
  let oldestValidMs = Infinity;
  let customerId = null;
  for (const r of pulled) {
    const t = parseTimeWindowStart(r?.timeWindow);
    if (!t || t.ms < startMs) continue;
    if (customerId == null && r?.customerId != null) customerId = String(r.customerId);
    validRows.push(r);
    if (t.ms < oldestValidMs) oldestValidMs = t.ms;
  }

  // 水位线与合并边界:正常完成 → watermark=now、合并边界=pullStart;
  // 触顶 → watermark/边界=已连续覆盖的最早整点,记 backlogUntil 断点续拉
  let newWatermark = nowMs;
  let newBacklog = null;
  let mergeStart = hourKeyOfMs(startMs);
  if (incomplete && oldestValidMs < Infinity) {
    const floor = floorToHour(oldestValidMs);
    newWatermark = floor;
    newBacklog = floor;
    mergeStart = hourKeyOfMs(floor);
  }

  const fresh = aggregateRows(validRows);
  state.settled = mergeBuckets(state.settled || {}, fresh, mergeStart);
  state.watermark = newWatermark;
  state.backlogUntil = newBacklog;

  const seenSegs = new Set(validRows.map((r) => keyIdSegmentOf(r?.apiKey)));
  return { customerId, pages, incomplete, seenSegs };
}

/** 账号档位(缓存 1 小时) */
async function fetchLevel(configKey, state, nowMs, timeoutMs) {
  if (state.level && typeof state.levelAt === 'number' && nowMs - state.levelAt < LEVEL_TTL_MS) {
    return state.level;
  }
  const get = makeGet(PROVIDER_ORIGIN[configKey.provider], configKey.apiKey, timeoutMs);
  const quota = await get('/api/monitor/usage/quota/limit');
  state.level = String(quota?.level || '').toUpperCase() || '未知';
  state.levelAt = nowMs;
  return state.level;
}

function sumBuckets(buckets) {
  let tokens = 0, peak = 0;
  for (const v of Object.values(buckets || {})) {
    tokens += v.tokens || 0;
    peak += v.peak || 0;
  }
  return { tokens, peak };
}

// ---------- 主查询 ----------
async function runQuery(timeoutMs = FETCH_TIMEOUT) {
  const now = new Date();
  const monthKey = monthKeyOf(now);
  const nowMs = now.getTime();
  const cfg = loadConfig();
  if (cfg.missing || !cfg.keys.length) {
    return { empty: true, month: monthKey, fetchedAt: nowMs, keys: [] };
  }
  const cache = loadCache(monthKey);

  // 1) 同步计划:已知账号增量拉(每账号一把代表 Key);段无映射/悬空的新 Key 走发现流程
  const { syncList, discoverList } = buildSyncPlan(cfg.keys, cache.keyAccount, cache.accounts);
  const accountErrors = {};   // customerId(或 solo:段)→ error 文案
  const accountMeta = {};     // customerId → { pages, incomplete }
  const synced = [];          // [{ customerId, configKey, state }](档位拉取用)
  for (const { cid, key } of syncList) {
    const state = cache.accounts[cid];
    try {
      const r = await syncAccount(key, state, monthKey, nowMs, timeoutMs);
      // solo 组归位:零用量期按 solo:段 建的组,一旦行内暴露真实 customerId 即改名;
      // 真实账号组已存在则丢弃平行副本(正组自建组起全月覆盖,数据不缺)
      let realCid = cid;
      if (String(cid).startsWith('solo:') && r.customerId) {
        realCid = String(r.customerId);
        if (!cache.accounts[realCid]) cache.accounts[realCid] = state;
        delete cache.accounts[cid];
        for (const [s, c] of Object.entries(cache.keyAccount)) {
          if (c === cid) cache.keyAccount[s] = realCid;
        }
      }
      accountMeta[realCid] = { pages: r.pages, incomplete: r.incomplete };
      synced.push({ customerId: realCid, configKey: key, state: cache.accounts[realCid] });
    } catch (e) {
      accountErrors[cid] = e.message;
    }
  }

  // 2) 发现流程:新 Key 拿自己认证全量拉取,行内 customerId 即真实账号(权威,不继承旧关联)
  for (const k of discoverList) {
    const seg = keyIdSegmentOf(k.apiKey);
    const tmp = { settled: {}, watermark: null, backlogUntil: null };
    try {
      const r = await syncAccount(k, tmp, monthKey, nowMs, timeoutMs);
      const cid = r.customerId ? String(r.customerId) : `solo:${seg}`;
      cache.keyAccount[seg] = cid;
      if (!(r.customerId && cache.accounts[cid])) {
        // 新建组:有 customerId → 命名组;零用量 → solo 组(出现用量后由上一步归位)
        cache.accounts[cid] = tmp;
        accountMeta[cid] = { pages: r.pages, incomplete: r.incomplete };
        synced.push({ customerId: cid, configKey: k, state: tmp });
      }
      // 命中既有账号:数据同源(该组自建组起全月覆盖,新段历史已在其中),丢弃临时态,只补映射
    } catch (e) {
      accountErrors[`solo:${seg}`] = e.message;
    }
  }

  // 3) 收尾清理:清已删 Key 的映射/孤儿账号,消除跨账号污染残留
  pruneCache(cache, cfg.keys);

  // 4) 档位(账号级,缓存 1h;失败不阻塞用量展示)
  for (const { customerId, configKey, state } of synced) {
    try { await fetchLevel(configKey, state, nowMs, timeoutMs); } catch { /* 档位失败容忍 */ }
  }

  // 5) 组装每把配置 Key 的卡片(段 = Key 身份,凭它取本账号 settled 中本段的数据)
  const keys = cfg.keys.map((k) => {
    const seg = keyIdSegmentOf(k.apiKey);
    const cid = cache.keyAccount[seg];
    const state = cid ? cache.accounts[cid] : null;
    const err = cid ? accountErrors[cid] : accountErrors[`solo:${seg}`];
    const { tokens, peak } = sumBuckets(state?.settled?.[seg]);
    const offPeak = Math.max(0, tokens - peak);
    const weighted = weightedOf(offPeak, peak);
    const percent = k.monthlyQuota > 0 ? (weighted / k.monthlyQuota) * 100 : 0;
    return {
      id: k.id,
      name: k.name,
      provider: k.provider,
      keyTail: maskKey(k.apiKey),
      level: state?.level || '未知',
      monthTokens: tokens,
      peakTokens: peak,
      offPeakTokens: offPeak,
      weightedTotal: weighted,
      monthlyQuota: k.monthlyQuota,
      percent,
      exhausted: percent >= 100,
      resetDate: dayKeyOf(nextMonthStartOf(now)),
      incomplete: cid ? !!(accountMeta[cid]?.incomplete) : false,
      error: err || null,
    };
  });

  const payload = { month: monthKey, fetchedAt: nowMs, keys };
  if (process.env.ZW_DEBUG) {
    payload.debug = {
      accounts: Object.fromEntries(Object.entries(accountMeta).map(([cid, m]) => [cid, m])),
      accountErrors,
      keyAccount: { ...cache.keyAccount },
      syncList: syncList.map(({ cid, key }) => ({ cid, authSeg: keyIdSegmentOf(key.apiKey) })),
      discoverList: discoverList.map((k) => keyIdSegmentOf(k.apiKey)),
    };
  }
  cache.lastResult = { ts: nowMs, month: monthKey, keys: payload.keys };
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

const LABEL_W = 14;
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
  if (k.incomplete) {
    lines.push(dim(`   (账单数据量过大,本轮未拉完,断点续拉中)`));
  }
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
  console.log(dim(`    ${now.toLocaleString('zh-CN')} · 按 Key 分钟级账单 · 加 --json 看原始数据`));
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
