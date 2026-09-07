// zcode-watch 纯函数单测(node --test,零依赖)
// 运行:node --test plugins/zcode-watch/skills/zcode-watch/scripts/zcode-watch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONTHLY_QUOTA,
  monthKeyOf, monthStartOf, nextMonthStartOf, dayKeyOf, fmtDateTime,
  peakWindowsBetween, weightedOf, parseConfig, resetCacheIfStale,
  fmtTokens, maskKey, daysUntilReset,
} from './zcode-watch.mjs';

// 日历事实:2026-09-01 是周二,09-05 周六,09-06 周日,09-07 周一
const D = (s) => new Date(s); // 'new Date("2026-09-07T13:00:00")' 按 Git Bash 本地时区解析

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

test('peakWindowsBetween:纯周末区间没有高峰窗口', () => {
  const ws = peakWindowsBetween(D('2026-09-05T00:00:00'), D('2026-09-06T15:00:00'));
  assert.deepEqual(ws, []);
});

test('peakWindowsBetween:周一 13:59,当天窗口未开始要跳过', () => {
  const now = D('2026-09-07T13:59:00');
  const ws = peakWindowsBetween(monthStartOf(now), now);
  // 月初 09-01 是周二:09-01~09-04(周二至周五)有窗口,09-05/06 周末跳过,09-07 周一未到 14:00 跳过
  assert.deepEqual(ws.map((w) => w.day), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
});

test('peakWindowsBetween:月初到周一 13:59 = 周二至周五 4 个已闭窗窗口', () => {
  const now = D('2026-09-07T13:59:00');
  const ws = peakWindowsBetween(monthStartOf(now), now);
  assert.deepEqual(ws.map((w) => w.day), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  for (const w of ws) {
    assert.equal(w.closed, true, `${w.day} 应已闭窗`);
    assert.deepEqual(w.start, D(`${w.day}T14:00:00`));
    assert.deepEqual(w.end, D(`${w.day}T18:00:00`));
  }
});

test('peakWindowsBetween:周一 15:30,当日窗口进行中(end 截到 now,未闭窗)', () => {
  const now = D('2026-09-07T15:30:00');
  const ws = peakWindowsBetween(monthStartOf(now), now);
  const today = ws.at(-1);
  assert.equal(today.day, '2026-09-07');
  assert.equal(today.closed, false);
  assert.deepEqual(today.start, D('2026-09-07T14:00:00'));
  assert.deepEqual(today.end, D('2026-09-07T15:30:00'));
});

test('peakWindowsBetween:周一 19:00,当日窗口已闭(end=18:00,可缓存)', () => {
  const now = D('2026-09-07T19:00:00');
  const ws = peakWindowsBetween(monthStartOf(now), now);
  const today = ws.at(-1);
  assert.equal(today.day, '2026-09-07');
  assert.equal(today.closed, true);
  assert.deepEqual(today.end, D('2026-09-07T18:00:00'));
});

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

test('resetCacheIfStale:跨月整体清空(月度重置的实现点)', () => {
  const stale = { version: 1, month: '2026-08', peakDays: { 'k1': { '2026-08-03': 5 } }, lastResult: { ts: 1 } };
  const fresh = resetCacheIfStale(stale, '2026-09');
  assert.equal(fresh.month, '2026-09');
  assert.deepEqual(fresh.peakDays, {});
  assert.equal(fresh.lastResult, null);
});

test('resetCacheIfStale:同月原样保留', () => {
  const cache = { version: 1, month: '2026-09', peakDays: { 'k1': { '2026-09-01': 5 } }, lastResult: { ts: 9 } };
  assert.deepEqual(resetCacheIfStale(cache, '2026-09'), cache);
});

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
