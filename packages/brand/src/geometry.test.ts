import { describe, expect, it } from 'vitest';
import { MARK_GEOMETRY, MARK_PARAMS, PETAL_COUNT, TASKBAR_PARAMS, fmt, markGeometry, petalPath } from './geometry.ts';

// 定稿花标的原始路径（换名前的成品 SVG 里抄来），用来锁住「花标一笔不改」
const REFERENCE = {
  long: 'M32 27C36.2 13.799999999999999 36.620000000000005 11.399999999999999 32 3C27.38 11.399999999999999 27.8 13.799999999999999 32 27Z',
  short: 'M32 27C35.4 18.2 35.74 16.6 32 11C28.259999999999998 16.6 28.6 18.2 32 27Z',
  groupTransform: 'translate(32 37) scale(1.15) translate(-32 -32)',
  hub: 4.5,
};

const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);

function expectSamePath(actual: string, expected: string) {
  const a = numbers(actual);
  const b = numbers(expected);
  expect(a.length).toBe(b.length);
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i] as number, 6));
  // 命令字母序列也要一致
  expect(actual.replace(/[^A-Za-z]/g, '')).toBe(expected.replace(/[^A-Za-z]/g, ''));
}

describe('花标几何', () => {
  it('九片瓣，每片隔 40°，0/120/240° 是长瓣', () => {
    const petals = MARK_GEOMETRY.petals;
    expect(petals).toHaveLength(PETAL_COUNT);
    expect(petals.map((p) => p.angle)).toEqual([0, 40, 80, 120, 160, 200, 240, 280, 320]);
    expect(petals.filter((p) => p.long).map((p) => p.angle)).toEqual([0, 120, 240]);
    expect(petals.filter((p) => p.long).map((p) => p.longIndex)).toEqual([0, 1, 2]);
  });

  it('长瓣 24 × 4.2、短瓣 16 × 3.4、轴 4.5、整体 1.15 倍、花心 (32,37)', () => {
    expect(MARK_PARAMS).toMatchObject({ longLength: 24, longWidth: 4.2, shortLength: 16, shortWidth: 3.4, hubRadius: 4.5, scale: 1.15, dy: 5 });
    expect(MARK_GEOMETRY.cx).toBe(32);
    expect(MARK_GEOMETRY.cy).toBe(37);
  });

  it('瓣形与定稿路径逐数相同', () => {
    const long = MARK_GEOMETRY.petals.find((p) => p.long)!;
    const short = MARK_GEOMETRY.petals.find((p) => !p.long)!;
    expectSamePath(long.d, REFERENCE.long);
    expectSamePath(short.d, REFERENCE.short);
    expect(MARK_GEOMETRY.groupTransform).toBe(REFERENCE.groupTransform);
    expect(MARK_GEOMETRY.params.hubRadius).toBe(REFERENCE.hub);
  });

  it('长瓣比短瓣长，且同类瓣形状完全一样', () => {
    const longs = new Set(MARK_GEOMETRY.petals.filter((p) => p.long).map((p) => p.d));
    const shorts = new Set(MARK_GEOMETRY.petals.filter((p) => !p.long).map((p) => p.d));
    expect(longs.size).toBe(1);
    expect(shorts.size).toBe(1);
    const tipY = (d: string) => Math.min(...numbers(d).filter((_, i) => i % 2 === 1));
    expect(tipY([...longs][0]!)).toBeLessThan(tipY([...shorts][0]!));
  });

  it('花不出 64 画框', () => {
    for (const geo of [MARK_GEOMETRY, markGeometry(TASKBAR_PARAMS)]) {
      expect(geo.bounds.top).toBeGreaterThanOrEqual(0);
      expect(geo.bounds.bottom).toBeLessThanOrEqual(64);
      expect(geo.bounds.left).toBeGreaterThanOrEqual(0);
      expect(geo.bounds.right).toBeLessThanOrEqual(64);
    }
  });
});

describe('任务栏光学版', () => {
  it('参数：放大 1.22、下移 5.65、长瓣宽 5.6、短瓣宽 4.6、轴 5.2，瓣长不变', () => {
    expect(TASKBAR_PARAMS).toEqual({ scale: 1.22, dy: 5.65, longLength: 24, longWidth: 5.6, shortLength: 16, shortWidth: 4.6, hubRadius: 5.2 });
  });

  it('只加粗放大，角度与长短规则不变', () => {
    const geo = markGeometry(TASKBAR_PARAMS);
    expect(geo.petals.map((p) => [p.angle, p.long])).toEqual(MARK_GEOMETRY.petals.map((p) => [p.angle, p.long]));
    expect(geo.petals[0]!.d).toBe(petalPath(24, 5.6));
    expect(geo.groupTransform).toBe('translate(32 37.65) scale(1.22) translate(-32 -32)');
  });
});

describe('fmt', () => {
  it('去掉浮点噪声', () => {
    expect(fmt(13.799999999999999)).toBe('13.8');
    expect(fmt(36.620000000000005)).toBe('36.62');
    expect(fmt(-0.00001)).toBe('0');
  });
});
