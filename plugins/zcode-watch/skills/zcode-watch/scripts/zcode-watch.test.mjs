// zcode-watch 纯函数单测(node --test,零依赖)
// 运行:node --test plugins/zcode-watch/skills/zcode-watch/scripts/zcode-watch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONTHLY_QUOTA,
  monthKeyOf, monthStartOf, nextMonthStartOf, dayKeyOf, fmtDateTime,
  parseBucketLabel, weekdayOfDateStr, isPeakBucket, splitSeriesByDay, chunkFetchRanges,
  weightedOf, parseConfig, resetCacheIfStale,
  fmtTokens, maskKey, daysUntilReset,
} from './zcode-watch.mjs';

// 日历事实:2026-09-01 是周二,09-05 周六,09-06 周日,09-07 周一,10-01 周四
const D = (s) => new Date(s);

// ---------- 基础日期 ----------
test('monthKeyOf / monthStartOf / nextMonthStartOf / dayKeyOf 基础日期', () => {
  assert.equal(monthKeyOf(D('2026-09-07T23:59:59')), '2026-09');
  assert.deepEqual(monthStartOf(D('2026-09-07T15:30:00')), D('2026-09-01T00:00:00'));
  assert.deepEqual(nextMonthStartOf(D('2026-09-07T15:30:00')), D('2026-10-01T00:00:00'));
  assert.deepEqual(nextMonthStartOf(D('2026-12-15T00:00:00')), D('2027-01-01T00:00:00'));
  assert.equal(dayKeyOf(D('2026-09-07T23:00:00')), '2026-09-07');
});

test('fmtDateTime 输出接口需要的 yyyy-MM-dd HH:mm:ss 本地格式', () => {
  assert.equal(fmtDateTime(D('2026-09-07T09:05:03')), '2026-09-07 09:05:03');
});

// ---------- 小时序列解析(服务端 x_time 为北京时间字符串,纯字符串切片,客户端时区无关) ----------
test('parseBucketLabel:小时标签与天标签(退化粒度)', () => {
  assert.deepEqual(parseBucketLabel('2026-09-07 14:00'), { date: '2026-09-07', hour: 14 });
  assert.deepEqual(parseBucketLabel('2026-09-07 00:00'), { date: '2026-09-07', hour: 0 });
  assert.deepEqual(parseBucketLabel('2026-09-07'), { date: '2026-09-07', hour: null });
});

test('weekdayOfDateStr:由日期字符串算星期(时区无关)', () => {
  assert.equal(weekdayOfDateStr('2026-09-07'), 1); // 周一
  assert.equal(weekdayOfDateStr('2026-09-05'), 6); // 周六
  assert.equal(weekdayOfDateStr('2026-09-06'), 0); // 周日
  assert.equal(weekdayOfDateStr('2026-10-01'), 4); // 周四
});

test('isPeakBucket:工作日 14:00–17:59 的小时桶为高峰(左闭右开,18 点桶不算)', () => {
  assert.equal(isPeakBucket('2026-09-07', 14), true);
  assert.equal(isPeakBucket('2026-09-07', 17), true);
  assert.equal(isPeakBucket('2026-09-07', 13), false);
  assert.equal(isPeakBucket('2026-09-07', 18), false); // 18 点桶是 18:00–19:00,非高峰
  assert.equal(isPeakBucket('2026-09-05', 14), false); // 周六
  assert.equal(isPeakBucket('2026-09-07', null), false); // 天粒度标签
});

test('splitSeriesByDay:按天聚合 tokens/calls,峰时单独累计', () => {
  const xTime = [
    '2026-09-07 10:00', '2026-09-07 14:00', '2026-09-07 15:00', '2026-09-07 18:00',
    '2026-09-08 09:00', '2026-09-08 17:00',
  ];
  const tokens = [100, 200, 50, 30, 40, 60];
  const calls = [1, 2, 3, 4, 5, 6];
  const days = splitSeriesByDay(xTime, tokens, calls);
  assert.deepEqual(days['2026-09-07'], { tokens: 380, peak: 250, calls: 10 });
  assert.deepEqual(days['2026-09-08'], { tokens: 100, peak: 60, calls: 11 });
});

test('splitSeriesByDay:天粒度标签直接抛错(引擎转为该 Key 的明确错误)', () => {
  assert.throws(() => splitSeriesByDay(['2026-09-07'], [100], [1]), /小时/);
});

test('splitSeriesByDay:空序列返回空对象;缺失值按 0 计', () => {
  assert.deepEqual(splitSeriesByDay([], [], []), {});
  const days = splitSeriesByDay(['2026-09-07 14:00'], [undefined], [null]);
  assert.deepEqual(days['2026-09-07'], { tokens: 0, peak: 0, calls: 0 });
});

// ---------- 取数分段(≤7 天保证小时粒度;endTime 桶为包含语义,相邻段边界用 23:59:59 防重复计入) ----------
const sec = 1000, day = 86400000;

test('chunkFetchRanges:稳态 = 昨天到现在的单段', () => {
  const rs = chunkFetchRanges(D('2026-09-06T00:00:00'), D('2026-09-07T22:00:00'));
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0], { start: D('2026-09-06T00:00:00'), end: D('2026-09-07T22:00:00') });
});

test('chunkFetchRanges:大跨度按 7 天分段,段内不超 7 天、首尾相接(差 1 秒)、末段收在 now', () => {
  const fetchFrom = D('2026-09-01T00:00:00');
  const now = D('2026-09-26T10:30:00');
  const rs = chunkFetchRanges(fetchFrom, now);
  assert.deepEqual(rs.map((r) => dayKeyOf(r.start)), ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']);
  assert.deepEqual(rs[0].end, D('2026-09-07T23:59:59'));
  assert.deepEqual(rs[1].end, D('2026-09-14T23:59:59'));
  assert.deepEqual(rs[2].end, D('2026-09-21T23:59:59'));
  assert.deepEqual(rs[3].end, now);
  for (let i = 0; i < rs.length; i++) {
    assert.ok(rs[i].end - rs[i].start <= 7 * day, `第 ${i} 段超 7 天`);
    if (i > 0) assert.equal(rs[i].start - rs[i - 1].end, sec, `第 ${i} 段与上段不衔接`);
  }
});

test('chunkFetchRanges:now 恰为分段边界时不产生零宽末段', () => {
  const rs = chunkFetchRanges(D('2026-09-01T00:00:00'), D('2026-09-08T00:00:00'));
  assert.equal(rs.length, 1); // 只有 [09-01 → 09-07 23:59:59],今天的零宽段跳过
  assert.deepEqual(rs[0].end, D('2026-09-07T23:59:59'));
});

test('chunkFetchRanges:同日小窗口返回单段', () => {
  const rs = chunkFetchRanges(D('2026-09-07T00:00:00'), D('2026-09-07T01:00:00'));
  assert.deepEqual(rs, [{ start: D('2026-09-07T00:00:00'), end: D('2026-09-07T01:00:00') }]);
});

// ---------- 加权与缓存 ----------
test('weightedOf:总使用额度 = 非高峰×1 + 高峰×3', () => {
  assert.equal(weightedOf(0, 0), 0);
  assert.equal(weightedOf(410, 610), 410 + 610 * 3);
});

test('parseConfig:BOM + CRLF 容错,缺省字段给默认值', () => {
  const text = '\uFEFF{"keys":\r\n[{"apiKey": " abc123 "}]}\r\n';
  const { keys } = parseConfig(text);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].apiKey, 'abc123');
  assert.equal(keys[0].provider, 'bigmodel');
  assert.equal(keys[0].monthlyQuota, DEFAULT_MONTHLY_QUOTA);
  assert.equal(keys[0].name, 'Key 1');
  assert.equal(keys[0].id, 'key-1');
});

test('parseConfig:zai 供应商保留,额度非法回退默认', () => {
  const { keys } = parseConfig('{"keys":[{"id":"k9","name":"备用","provider":"zai","apiKey":"x","monthlyQuota":0}]}');
  assert.equal(keys[0].provider, 'zai');
  assert.equal(keys[0].monthlyQuota, DEFAULT_MONTHLY_QUOTA);
  assert.equal(keys[0].name, '备用');
  assert.equal(keys[0].id, 'k9');
});

test('parseConfig:坏 JSON / keys 非数组 / 缺 apiKey 都要抛明确错误', () => {
  assert.throws(() => parseConfig('{oops'), /JSON/);
  assert.throws(() => parseConfig('{"keys":{}}'), /keys/);
  assert.throws(() => parseConfig('{"keys":[{"name":"无Key"}]}'), /apiKey/);
});

test('resetCacheIfStale:跨月整体清空 days 与 lastResult(月度重置的实现点)', () => {
  const stale = { version: 2, month: '2026-08', days: { k1: { '2026-08-03': { tokens: 5, peak: 1 } } }, lastResult: { ts: 1 } };
  const fresh = resetCacheIfStale(stale, '2026-09');
  assert.equal(fresh.month, '2026-09');
  assert.deepEqual(fresh.days, {});
  assert.equal(fresh.lastResult, null);
});

test('resetCacheIfStale:同月原样保留', () => {
  const cache = { version: 2, month: '2026-09', days: { k1: { '2026-09-01': { tokens: 5, peak: 1 } } }, lastResult: { ts: 9 } };
  assert.deepEqual(resetCacheIfStale(cache, '2026-09'), cache);
});

// ---------- 展示辅助 ----------
test('fmtTokens:亿/万/千分位三档', () => {
  assert.equal(fmtTokens(1750000000), '17.50 亿');
  assert.equal(fmtTokens(120000000), '1.20 亿');
  assert.equal(fmtTokens(50000), '5.0 万');
  assert.equal(fmtTokens(12345), '1.2 万');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(0), '0');
});

test('maskKey:只露尾号 4 位', () => {
  assert.equal(maskKey('abcdefgh'), '····efgh');
  assert.equal(maskKey('abcd'), '····');
});

test('daysUntilReset:距离下月 1 号的天数(向上取整)', () => {
  assert.equal(daysUntilReset(D('2026-09-07T12:00:00')), 24);
  assert.equal(daysUntilReset(D('2026-09-30T23:59:00')), 1);
  assert.equal(daysUntilReset(D('2026-10-01T00:00:00')), 31);
});
