// zcode-watch 纯函数单测(node --test,零依赖)
// 运行:node --test plugins/zcode-watch/skills/zcode-watch/scripts/zcode-watch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONTHLY_QUOTA, MIN_WINDOW_HOURS,
  monthKeyOf, nextMonthStartOf, dayKeyOf,
  parseBillTime, parseTimeWindowStart, isPeakMinute,
  keyIdSegmentOf, aggregateRows, computePullStart, mergeBuckets,
  weightedOf, parseConfig, resetCacheIfStale, migrateCache, buildSyncPlan, pruneCache,
  fmtTokens, maskKey, daysUntilReset,
} from './zcode-watch.mjs';

// 日历事实:2026-09-04 是周五,09-05 周六,09-06 周日,09-07 周一
const D = (s) => new Date(s);

// ---------- 时间解析(账单 timeWindow 为服务端北京时间字符串;纯字符串切片,+08:00 折算 epoch,时区无关) ----------
test('parseBillTime:补零与不补零都吃,输出 date/hourKey/minuteOfDay/ms', () => {
  const a = parseBillTime('2026-09-08 11:25:00');
  assert.equal(a.date, '2026-09-08');
  assert.equal(a.hourKey, '2026-09-08 11');
  assert.equal(a.minuteOfDay, 11 * 60 + 25);
  assert.equal(a.ms, Date.parse('2026-09-08T11:25:00+08:00'));
  const b = parseBillTime('2026-9-4 1:05:00');
  assert.equal(b.date, '2026-09-04');
  assert.equal(b.hourKey, '2026-09-04 01');
  assert.equal(b.minuteOfDay, 65);
  assert.equal(parseBillTime('not a time'), null);
  assert.equal(parseBillTime(''), null);
});

test('parseTimeWindowStart:取波浪线左侧起始时刻,容忍空格,畸形返回 null', () => {
  const t = parseTimeWindowStart('2026-09-08 11:25:00~2026-09-08 11:26:00');
  assert.equal(t.minuteOfDay, 11 * 60 + 25);
  assert.equal(parseTimeWindowStart('2026-9-4 00:00:00 ~ 2026-9-4 23:59:59').date, '2026-09-04');
  assert.equal(parseTimeWindowStart(''), null);
  assert.equal(parseTimeWindowStart('随便'), null);
});

test('isPeakMinute:工作日 14:00–17:59 为高峰(分钟级,18:00 起非高峰,周末不算)', () => {
  assert.equal(isPeakMinute('2026-09-07', 13 * 60 + 59), false); // 周一 13:59
  assert.equal(isPeakMinute('2026-09-07', 14 * 60), true);        // 周一 14:00
  assert.equal(isPeakMinute('2026-09-07', 17 * 60 + 59), true);   // 周一 17:59
  assert.equal(isPeakMinute('2026-09-07', 18 * 60), false);       // 周一 18:00
  assert.equal(isPeakMinute('2026-09-05', 15 * 60), false);       // 周六
  assert.equal(isPeakMinute('坏日期', 900), false);                // 容错
});

// ---------- Key 段匹配 ----------
test('keyIdSegmentOf:取第一个点号前的 ID 段,无点号整串兜底', () => {
  assert.equal(keyIdSegmentOf('d65d3bb2f5194802943ae8e8e432a222.kJqTsecret'), 'd65d3bb2f5194802943ae8e8e432a222');
  assert.equal(keyIdSegmentOf('d65d3bb2f5194802943ae8e8e432a222.a.b'), 'd65d3bb2f5194802943ae8e8e432a222');
  assert.equal(keyIdSegmentOf('nodotkey'), 'nodotkey');
  assert.equal(keyIdSegmentOf('  trim.me  '), 'trim');
});

// ---------- 明细行聚合 ----------
test('aggregateRows:按 apiKey段×小时桶聚合,峰时按行时间判定,只计 输入/输出/缓存命中', () => {
  const rows = [
    // 周一 14:25 高峰分钟窗
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-07 14:25:00~2026-09-07 14:26:00', tokenType: '输入', usageCount: 100 },
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-07 14:25:00~2026-09-07 14:26:00', tokenType: '缓存命中', usageCount: 50 },
    // 同 Key 周一 15:00(仍高峰,另一小时桶)
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-07 15:00:00~2026-09-07 15:01:00', tokenType: '输出', usageCount: 30 },
    // 同 Key 周一 18:30(非高峰)
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-07 18:30:00~2026-09-07 18:31:00', tokenType: '输入', usageCount: 40 },
    // 周六 15:00(周末非高峰)
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-05 15:00:00~2026-09-05 15:01:00', tokenType: '输入', usageCount: 60 },
    // 工具行(按次计)与畸形行:不计入
    { apiKey: 'aaa111.xxx', timeWindow: '2026-09-07 14:25:00~2026-09-07 14:26:00', tokenType: '不区分输入输出', usageCount: 999 },
    { apiKey: 'aaa111.xxx', timeWindow: '', tokenType: '输入', usageCount: 5 },
    // 另一把 Key
    { apiKey: 'bbb222.yyy', timeWindow: '2026-09-07 14:25:00~2026-09-07 14:26:00', tokenType: '输入', usageCount: 7 },
    // 未配置的 Key 段:同样聚合缓存(后续添加该 Key 即有历史),展示层不读
    { apiKey: 'ccc333.zzz', timeWindow: '2026-09-07 14:25:00~2026-09-07 14:26:00', tokenType: '输入', usageCount: 8 },
  ];
  const agg = aggregateRows(rows);
  assert.deepEqual(agg['aaa111']['2026-09-07 14'], { tokens: 150, peak: 150 });
  assert.deepEqual(agg['aaa111']['2026-09-07 15'], { tokens: 30, peak: 30 });
  assert.deepEqual(agg['aaa111']['2026-09-07 18'], { tokens: 40, peak: 0 });
  assert.deepEqual(agg['aaa111']['2026-09-05 15'], { tokens: 60, peak: 0 });
  assert.deepEqual(agg['bbb222']['2026-09-07 14'], { tokens: 7, peak: 7 });
  assert.deepEqual(agg['ccc333']['2026-09-07 14'], { tokens: 8, peak: 8 });
});

// ---------- 缺口窗口计算 ----------
const H = 3600_000;
const BASE = 1_800_000_000_000; // 恰为整点(epoch 对齐北京时间整小时)

test('computePullStart:无缓存(首刷)→ 从月初全量', () => {
  const monthStart = BASE - 240 * H;
  const r = computePullStart(null, BASE, null, monthStart);
  assert.equal(r.startMs, monthStart);
  assert.equal(r.gapMs, Infinity);
});

test('computePullStart:gap 1h50m < 2h 保底 → 窗口 2h,起点向下取整到整点', () => {
  const r = computePullStart(BASE - 110 * 60_000, BASE, null, BASE - 240 * H);
  assert.equal(r.windowHours, MIN_WINDOW_HOURS);
  assert.equal(r.startMs, BASE - 2 * H);
});

test('computePullStart:gap 27h10m → 窗口 28h(向上取整到小时)', () => {
  const r = computePullStart(BASE - (27 * H + 10 * 60_000), BASE, null, BASE - 240 * H);
  assert.equal(r.windowHours, 28);
  assert.equal(r.startMs, BASE - 28 * H);
});

test('computePullStart:gap 恰 85h 整 → 窗口 85h(无缝衔接上次 watermark)', () => {
  const r = computePullStart(BASE - 85 * H, BASE, null, BASE - 240 * H);
  assert.equal(r.windowHours, 85);
  assert.equal(r.startMs, BASE - 85 * H);
});

test('computePullStart:时钟回拨(gap ≤ 0)→ 按保底 2h 处理', () => {
  const r = computePullStart(BASE + 5 * 60_000, BASE, null, BASE - 240 * H);
  assert.equal(r.windowHours, MIN_WINDOW_HOURS);
  assert.equal(r.startMs, BASE - 2 * H);
});

test('computePullStart:backlogUntil 比常规起点更早 → 起点延伸到 backlog(断点续拉)', () => {
  const r = computePullStart(BASE - 1 * H, BASE, BASE - 50 * H, BASE - 240 * H);
  assert.equal(r.startMs, BASE - 50 * H);
});

test('computePullStart:任何情况不早于当月 1 日 00:00', () => {
  const r = computePullStart(BASE - 30 * H, BASE, BASE - 90 * H, BASE - 3 * H);
  assert.equal(r.startMs, BASE - 3 * H);
});

// ---------- 小时桶覆盖合并 ----------
test('mergeBuckets:≥ 起点的桶以 fresh 覆盖(不在 fresh 即为 0,删除),< 起点的保持不动', () => {
  const settled = { aaa111: { '09-05 13': { tokens: 10, peak: 1 }, '09-05 14': { tokens: 20, peak: 2 }, '09-05 15': { tokens: 30, peak: 3 } } };
  const fresh = { aaa111: { '09-05 15': { tokens: 35, peak: 4 } } };
  const out = mergeBuckets(settled, fresh, '09-05 14');
  assert.deepEqual(out['aaa111'], {
    '09-05 13': { tokens: 10, peak: 1 },   // < 起点:保持
    '09-05 15': { tokens: 35, peak: 4 },    // ≥ 起点:覆盖
    // '09-05 14' ≥ 起点但 fresh 无 → 视为 0,删除
  });
});

test('mergeBuckets:多个 Key 段互不影响;固化区的段保留,重算区无行的段清零;空入参安全', () => {
  const settled = {
    a: { '1 10': { tokens: 1, peak: 0 } },   // 重算区,fresh 有 → 覆盖
    b: { '1 10': { tokens: 2, peak: 2 } },   // 重算区,fresh 无 → 该窗口用量为 0,删除
    c: { '1 08': { tokens: 4, peak: 1 } },   // 固化区(< 起点)→ 保留
  };
  const fresh = { a: { '1 10': { tokens: 9, peak: 0 } } };
  const out = mergeBuckets(settled, fresh, '1 09');
  assert.deepEqual(out.a['1 10'], { tokens: 9, peak: 0 });
  assert.equal(out.b, undefined);
  assert.deepEqual(out.c['1 08'], { tokens: 4, peak: 1 });
  assert.deepEqual(mergeBuckets({}, {}, 'x'), {});
});

// ---------- 缓存 v4(段键控关联) ----------
test('resetCacheIfStale:跨月整体清空;同月原样保留', () => {
  const stale = { version: 4, month: '2026-08', accounts: { c1: { watermark: 1 } }, keyAccount: { aaa: 'c1' }, lastResult: { ts: 1 } };
  const fresh = resetCacheIfStale(stale, '2026-09');
  assert.deepEqual(fresh, { version: 4, month: '2026-09', accounts: {}, keyAccount: {}, lastResult: null });
  const same = { version: 4, month: '2026-09', accounts: { c1: { watermark: 2 } }, keyAccount: {}, lastResult: null };
  assert.deepEqual(resetCacheIfStale(same, '2026-09'), same);
});

test('migrateCache:v3(id 键控)→ v4:账号数据/档位保留,id 关联(keyAccount/authKeyId/keyMap)全丢弃', () => {
  const v3 = {
    version: 3, month: '2026-09',
    accounts: {
      c1: {
        authKeyId: 'key-1',
        keyMap: { oldseg: 'key-1' },
        watermark: 123, backlogUntil: null,
        settled: { oldseg: { '2026-09-01 10': { tokens: 5, peak: 0 } } },
        level: 'MAX', levelAt: 456,
      },
    },
    keyAccount: { 'key-1': 'c1' },  // id 键控:换 Key 复用 key-1 时会错挂,迁移必须丢弃
    lastResult: { ts: 1 },
  };
  const m = migrateCache(v3);
  assert.equal(m.version, 4);
  assert.equal(m.month, '2026-09');
  assert.deepEqual(m.keyAccount, {});
  assert.deepEqual(m.accounts.c1, {
    settled: v3.accounts.c1.settled, watermark: 123, backlogUntil: null, level: 'MAX', levelAt: 456,
  });
  assert.equal('authKeyId' in m.accounts.c1, false);
  assert.equal('keyMap' in m.accounts.c1, false);
  assert.deepEqual(m.lastResult, { ts: 1 });
});

test('migrateCache:垃圾输入 → 空 v4;已是 v4 → 原样返回', () => {
  assert.deepEqual(migrateCache(null), { version: 4, month: null, accounts: {}, keyAccount: {}, lastResult: null });
  assert.deepEqual(migrateCache('oops'), { version: 4, month: null, accounts: {}, keyAccount: {}, lastResult: null });
  const v4 = { version: 4, month: '2026-09', accounts: { c: {} }, keyAccount: { s: 'c' }, lastResult: null };
  assert.equal(migrateCache(v4), v4);
});

// ---------- 同步计划(回归:换 Key 复用 id 不得继承旧账号) ----------
const K = (id, seg) => ({ id, apiKey: `${seg}.secret`, provider: 'bigmodel' });

test('buildSyncPlan:段无映射的新 Key 走发现流程——即使 id 与旧 Key 相同(v0.4.0 事故回归)', () => {
  // 旧 Key oldseg 属账号 c1;用户删旧加新,新 Key 复用 id "key-1" 但段是 newseg(另一账号)
  const plan = buildSyncPlan([K('key-1', 'newseg')], { oldseg: 'c1' }, { c1: {} });
  assert.deepEqual(plan.syncList, []);                       // 绝不拿新 Key 当 c1 的代表去增量拉
  assert.equal(plan.discoverList.length, 1);
  assert.equal(plan.discoverList[0].apiKey, 'newseg.secret'); // 必须走发现流程定位真实账号
});

test('buildSyncPlan:同账号多 Key 只出一列(取配置顺序第一把为代表);悬空映射走发现', () => {
  const keys = [K('key-1', 'aaa'), K('key-2', 'bbb'), K('key-3', 'ccc')];
  const plan = buildSyncPlan(keys, { aaa: 'c1', bbb: 'c1', gone: 'c9' }, { c1: {} });
  assert.deepEqual(plan.syncList, [{ cid: 'c1', key: keys[0] }]); // c1 一列,代表 = aaa
  assert.deepEqual(plan.discoverList, [keys[2]]);                 // ccc 无映射;gone→c9 悬空不在此列
  const plan2 = buildSyncPlan([K('key-4', 'ddd')], { ddd: 'c9' }, { c1: {} });
  assert.equal(plan2.discoverList.length, 1);                     // 映射指向不存在的账号 → 重新发现
});

// ---------- 收尾清理 ----------
test('pruneCache:清已删 Key 的映射与孤儿账号;跨账号污染段从非正主账号剔除', () => {
  const cache = {
    version: 4, month: '2026-09',
    accounts: {
      c1: { settled: { aaa: { h: 1 }, polluted: { h: 2 } }, watermark: 1 }, // polluted 是 c2 的段,错并入 c1
      c2: { settled: { polluted: { h: 3 } }, watermark: 2 },
      c3: { settled: {} },                                                  // 孤儿:无任何映射指向
    },
    keyAccount: { aaa: 'c1', polluted: 'c2', deletedSeg: 'c3' },
    lastResult: null,
  };
  pruneCache(cache, [K('key-1', 'aaa'), K('key-2', 'polluted')]);
  assert.deepEqual(cache.keyAccount, { aaa: 'c1', polluted: 'c2' }); // deletedSeg 清除
  assert.deepEqual(Object.keys(cache.accounts).sort(), ['c1', 'c2']); // 孤儿 c3 连同数据清除
  assert.equal('polluted' in cache.accounts.c1.settled, false);       // c1 中的污染残留剔除
  assert.ok('polluted' in cache.accounts.c2.settled);                 // 正主账号数据不动
  assert.ok('aaa' in cache.accounts.c1.settled);
});

// ---------- 加权 / 配置 / 展示(沿用) ----------
test('weightedOf:总使用额度 = 非高峰×1 + 高峰×3', () => {
  assert.equal(weightedOf(0, 0), 0);
  assert.equal(weightedOf(410, 610), 410 + 610 * 3);
});

test('parseConfig:BOM + CRLF 容错,缺省字段给默认值', () => {
  const { keys } = parseConfig('\uFEFF{"keys":\r\n[{"apiKey": " abc123 "}]}\r\n');
  assert.equal(keys[0].apiKey, 'abc123');
  assert.equal(keys[0].provider, 'bigmodel');
  assert.equal(keys[0].monthlyQuota, DEFAULT_MONTHLY_QUOTA);
  assert.equal(keys[0].name, 'Key 1');
  assert.equal(keys[0].id, 'key-1');
});

test('parseConfig:坏 JSON / keys 非数组 / 缺 apiKey 都要抛明确错误', () => {
  assert.throws(() => parseConfig('{oops'), /JSON/);
  assert.throws(() => parseConfig('{"keys":{}}'), /keys/);
  assert.throws(() => parseConfig('{"keys":[{"name":"无Key"}]}'), /apiKey/);
});

test('fmtTokens:亿/万/千分位三档;maskKey 只露尾号 4 位', () => {
  assert.equal(fmtTokens(1750000000), '17.50 亿');
  assert.equal(fmtTokens(50000), '5.0 万');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(0), '0');
  assert.equal(maskKey('abcdefgh'), '····efgh');
  assert.equal(maskKey('abcd'), '····');
});

test('日期辅助:monthKeyOf / nextMonthStartOf / dayKeyOf / daysUntilReset', () => {
  assert.equal(monthKeyOf(D('2026-09-07T23:59:59')), '2026-09');
  assert.deepEqual(nextMonthStartOf(D('2026-12-15T00:00:00')), D('2027-01-01T00:00:00'));
  assert.equal(dayKeyOf(D('2026-09-07T23:00:00')), '2026-09-07');
  assert.equal(daysUntilReset(D('2026-09-07T12:00:00')), 24);
});
