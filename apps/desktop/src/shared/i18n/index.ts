// The interface's languages: Simplified Chinese (the source and the fallback), Traditional Chinese and English.
//
// The key of every phrase is its Simplified Chinese text, as written in the code: t('开机时启动'). Simplified needs
// no catalog (t returns the key), so the Simplified interface stays word for word what it was. The other languages
// look the key up in their catalog (./zh-TW, ./en); a phrase missing there shows in Simplified, never as a key or
// blank. Variables are {name} in the text; a phrase whose meaning depends on where it is gets a context (tc).
// Shared by the main process and every renderer page (window, dialog window, flow window).
import { EN } from './en';
import { ZH_TW } from './zh-TW';

export type Locale = 'zh-CN' | 'zh-TW' | 'en';
/** 外观 › 显示 › 语言: follow Windows, or one of the languages. */
export type LanguagePref = 'system' | Locale;

export const LOCALES: readonly Locale[] = ['zh-CN', 'zh-TW', 'en'];

/** The choices of 语言, each language named in itself (not translated). */
export const LANGUAGE_NAMES: Record<Locale, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' };

/** One translation: a text, or for English the text for one and for any other count (picked by the `n` variable). */
export type Entry = string | { one: string; other: string };
export type Catalog = Readonly<Record<string, Entry>>;

const CATALOGS: Record<Locale, Catalog> = { 'zh-CN': {}, 'zh-TW': ZH_TW, en: EN };

export function isLocale(v: unknown): v is Locale {
  return v === 'zh-CN' || v === 'zh-TW' || v === 'en';
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return v === 'system' || isLocale(v);
}

/**
 * The language for a system language list (Electron's app.getPreferredSystemLanguages(), most preferred first):
 * Traditional for zh-TW / zh-HK / zh-MO / zh-Hant, Simplified for other Chinese, English for the rest. The first
 * entry decides; an empty list is Simplified (the app's own language).
 */
export function systemLocale(languages: readonly string[]): Locale {
  const first = languages[0]?.toLowerCase();
  if (!first) return 'zh-CN';
  if (/^zh\b/.test(first)) return /\bhant\b|^zh-(tw|hk|mo)\b/.test(first) ? 'zh-TW' : 'zh-CN';
  return 'en';
}

export function resolveLocale(pref: LanguagePref | undefined, systemLanguages: readonly string[]): Locale {
  return pref && pref !== 'system' ? pref : systemLocale(systemLanguages);
}

let current: Locale = 'zh-CN';
const listeners = new Set<(locale: Locale) => void>();

export function getLocale(): Locale {
  return current;
}

/** Switches the language for everything that calls t() from now on, and tells the listeners. */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const l of listeners) l(locale);
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Variables put into a phrase: {name} in the text. `n` also picks the English one / other form. */
export type Vars = Readonly<Record<string, string | number>>;

/** Fills {name} with vars[name]; braces that name no variable stay as written. */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

function pick(entry: Entry, vars?: Vars): string {
  if (typeof entry === 'string') return entry;
  return vars?.n === 1 ? entry.one : entry.other;
}

/** The text of a key in a language, unfilled; the key itself (Simplified) when the catalog lacks it. */
export function lookup(key: string, locale: Locale = current, vars?: Vars): string {
  const entry = CATALOGS[locale][key];
  if (entry !== undefined) return pick(entry, vars);
  // A key with a context ("打开|开关") shows its text without the context in Simplified.
  const bar = key.indexOf('|');
  return bar < 0 ? key : key.slice(0, bar);
}

/** A phrase in the current language. The key is the Simplified text, written literally (a test reads them). */
export function t(key: string, vars?: Vars): string {
  return fill(lookup(key, current, vars), vars);
}

/** A phrase whose translation depends on where it is: `ctx` is a short English word ("switch", "menu"). */
export function tc(ctx: string, key: string, vars?: Vars): string {
  return fill(lookup(`${key}|${ctx}`, current, vars), vars);
}

/**
 * Marks a literal as a key without translating it, for tables built when a module loads (the choices of a
 * setting, a tool's name): the table keeps the key, and the place that shows it calls t(table[x]).
 */
export function N_(key: string): string {
  return key;
}

/**
 * A text that came from elsewhere (the core, a plugin package) in Simplified: translated when the catalog has it
 * word for word, shown as it is otherwise. The keys it can meet are listed with N_ where they are known.
 */
export function tx(text: string): string {
  return lookup(text);
}

/** The language for Intl (dates, numbers). */
export function intlLocale(locale: Locale = current): string {
  return locale === 'en' ? 'en-US' : locale;
}

/** The lang attribute of a page (Traditional needs zh-TW so Chinese draws in the Traditional font). */
export function htmlLang(locale: Locale = current): string {
  return locale === 'en' ? 'en' : locale;
}

/** For tests: the catalogs. */
export function catalogFor(locale: Locale): Catalog {
  return CATALOGS[locale];
}
