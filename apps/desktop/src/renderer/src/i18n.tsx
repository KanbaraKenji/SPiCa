// The interface language in a renderer page: switching it (from 外观 › 显示 › 语言), the hook that redraws a part of
// the page not under App, and phrases with React nodes in them. The words themselves are in shared/i18n.
import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { getLocale, htmlLang, lookup, onLocaleChange, resolveLocale, setLocale, type LanguagePref, type Locale } from '../../shared/i18n';

/** Sets the language for a 语言 setting, and the page's lang (the Traditional font, shared/ui-font.ts). */
export function applyLanguage(pref: LanguagePref | undefined, systemLanguages: readonly string[], root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): Locale {
  const locale = resolveLocale(pref, systemLanguages);
  setLocale(locale);
  if (root) root.lang = htmlLang(locale);
  return locale;
}

/**
 * The current language, redrawing the component when it changes. App redraws with the settings anyway; parts of
 * the page outside it (CloseAsk, TextMenu) and anything kept in a memo call this.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/**
 * A phrase with React nodes in it: {name} takes nodes[name] (a button, a link, bold text), so a language can put
 * them where its word order wants. The key is the Simplified text, written literally (a test reads them).
 */
export function tn(key: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const text = lookup(key);
  const parts = text.split(/\{(\w+)\}/);
  return parts.map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{part in nodes ? nodes[part] : `{${part}}`}</Fragment> : part));
}
