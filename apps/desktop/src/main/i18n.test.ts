// The languages: t() and its fallbacks, and the source read for words that bypass it (written straight into the
// code, which would show in Simplified whatever the language) and for keys a catalog lacks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogFor, fill, getLocale, LOCALES, N_, onLocaleChange, resolveLocale, setLocale, systemLocale, t, tc, tx, type Catalog, type Locale } from '../shared/i18n';
import { scanSource, varsOf } from '../shared/i18n/scan';

const DESKTOP = join(__dirname, '..');
const I18N = join(DESKTOP, 'shared', 'i18n');
/** Where the interface's words are: the three renderer pages, the main process, the code both share. */
const ROOTS = ['renderer', 'main', 'shared', 'backend'].map((d) => join(DESKTOP, d));
/** Demo data (sample mail, chats, plugins) and this folder are not interface wording. */
const SKIP_FILE = /(^|\/)(fake[\w-]*|demo[\w-]*|shots)\.ts$|(^|\/)shared\/i18n\/|(^|\/)testing\//;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

const rel = (p: string) => relative(DESKTOP, p).replace(/\\/g, '/');
const sources = ROOTS.flatMap(files)
  .map((p) => ({ path: rel(p), found: scanSource(readFileSync(p, 'utf8')) }))
  .filter((s) => !SKIP_FILE.test(s.path));

/** Files not moved over yet (one path per line in pending.txt); the list only shrinks. */
const PENDING = new Set(
  readFileSync(join(I18N, 'pending.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')),
);

afterEach(() => setLocale('zh-CN'));

describe('t()', () => {
  it('is the Simplified text itself in Simplified, with its variables filled', () => {
    expect(t('开机时启动')).toBe('开机时启动');
    expect(t('退出 {app}', { app: 'Spica' })).toBe('退出 Spica');
    expect(tc('switch', '打开')).toBe('打开');
  });

  it('is the catalog’s text in another language, and Simplified where the catalog lacks it', () => {
    setLocale('en');
    expect(t('语言')).toBe('Language');
    expect(t('一句没有译文的话')).toBe('一句没有译文的话');
    expect(tc('nowhere', '一句没有译文的话')).toBe('一句没有译文的话');
    setLocale('zh-TW');
    expect(t('语言')).toBe('語言');
  });

  it('leaves braces that name no variable as they are', () => {
    expect(fill('{a} 和 {b} 和 { c }', { a: 1 })).toBe('1 和 {b} 和 { c }');
  });

  it('picks the English one / other form by n', () => {
    // the catalog's entry shape, checked on a made-up key through lookup's rule
    const entry = { one: '{n} file', other: '{n} files' };
    const pick = (n: number) => fill(n === 1 ? entry.one : entry.other, { n });
    expect([pick(1), pick(3)]).toEqual(['1 file', '3 files']);
  });

  it('N_ marks without translating; tx translates a text from elsewhere when the catalog has it', () => {
    setLocale('en');
    expect(N_('语言')).toBe('语言');
    expect(tx('语言')).toBe('Language');
    expect(tx('内核给的一句话')).toBe('内核给的一句话');
  });

  it('tells listeners when the language changes, once', () => {
    const seen: Locale[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale('en');
    setLocale('en');
    setLocale('zh-TW');
    off();
    setLocale('zh-CN');
    expect(seen).toEqual(['en', 'zh-TW']);
    expect(getLocale()).toBe('zh-CN');
  });
});

describe('跟随系统', () => {
  it('is Traditional for Taiwan, Hong Kong, Macau and Hant, Simplified for other Chinese, English otherwise', () => {
    expect(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW', 'zh-Hant'].map((l) => systemLocale([l]))).toEqual(['zh-TW', 'zh-TW', 'zh-TW', 'zh-TW', 'zh-TW']);
    expect(['zh-CN', 'zh', 'zh-Hans-CN', 'zh-SG'].map((l) => systemLocale([l]))).toEqual(['zh-CN', 'zh-CN', 'zh-CN', 'zh-CN']);
    expect(['en-US', 'ja-JP', 'de'].map((l) => systemLocale([l]))).toEqual(['en', 'en', 'en']);
    expect(systemLocale([])).toBe('zh-CN');
    expect(systemLocale(['en-GB', 'zh-CN'])).toBe('en');
  });

  it('a chosen language wins over the system’s', () => {
    expect(resolveLocale('zh-TW', ['en-US'])).toBe('zh-TW');
    expect(resolveLocale('system', ['en-US'])).toBe('en');
    expect(resolveLocale(undefined, ['zh-HK'])).toBe('zh-TW');
  });
});

describe('the source', () => {
  it('reads keys, contexts and words written straight in', () => {
    const src = [
      "const a = t('语言');",
      "const b = tc('menu', '打开');",
      "const c = `退出 ${APP_NAME}`;",
      '<p>直接写的字</p>',
      "// 注释里的字",
      "const d = '给模型的话'; // i18n-skip",
      "const e = N_('每次询问');",
      "const f = t(`模板 ${x}`);",
    ].join('\n');
    expect(scanSource(src).map((f) => [f.line, f.key ?? null])).toEqual([
      [1, '语言'],
      [2, '打开|menu'],
      [3, null],
      [4, null],
      [7, '每次询问'],
      [8, null],
    ]);
  });

  it('has no words written straight into the code outside the files not moved over yet', () => {
    const hits: string[] = [];
    for (const s of sources) {
      if (PENDING.has(s.path)) continue;
      for (const f of s.found) if (!f.key) hits.push(`${s.path}:${f.line} ${f.text}`);
    }
    expect(hits).toEqual([]);
  });

  it('pending.txt lists only files that still have such words', () => {
    const left = new Set(sources.filter((s) => s.found.some((f) => !f.key)).map((s) => s.path));
    expect([...PENDING].filter((p) => !left.has(p))).toEqual([]);
  });
});

const keys = new Map<string, string>();
for (const s of sources) for (const f of s.found) if (f.key && !keys.has(f.key)) keys.set(f.key, `${s.path}:${f.line}`);

describe.each(LOCALES.filter((l) => l !== 'zh-CN'))('the %s catalog', (locale) => {
  const catalog: Catalog = catalogFor(locale);

  it('has every key the moved-over files use', () => {
    const missing = [...keys].filter(([k]) => catalog[k] === undefined).map(([k, at]) => `${at} ${k}`);
    expect(missing).toEqual([]);
  });

  it('has no key the source does not use', () => {
    expect(Object.keys(catalog).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('keeps each key’s variables, and no Simplified-only punctuation in English', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(catalog)) {
      const want = varsOf(k.split('|')[0]!).join(',');
      for (const text of typeof v === 'string' ? [v] : [v.one, v.other]) {
        if (varsOf(text).join(',') !== want) bad.push(`${k} → ${text}`);
        if (locale === 'en' && /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(text)) bad.push(`${k} → ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the area files', () => {
  it('say the same thing where two of them have the same key', async () => {
    const clash: string[] = [];
    for (const locale of ['en', 'zh-TW']) {
      const dir = join(I18N, locale);
      const seen = new Map<string, { text: unknown; file: string }>();
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
        const mod = (await import(`../shared/i18n/${locale}/${name.replace(/\.ts$/, '')}`)) as Record<string, Catalog>;
        for (const part of Object.values(mod))
          for (const [k, v] of Object.entries(part)) {
            const was = seen.get(k);
            if (was && JSON.stringify(was.text) !== JSON.stringify(v)) clash.push(`${locale} ${k}: ${was.file} ≠ ${name}`);
            seen.set(k, { text: v, file: name });
          }
      }
    }
    expect(clash).toEqual([]);
  });
});
