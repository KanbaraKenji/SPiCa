// A plugin's words in the interface's languages (optional; manifest.json · i18n). A plugin writes its fields once
// (display_name, description…) in whatever language it likes; `i18n` adds a copy of the words people read for
// Simplified Chinese, Traditional Chinese or English. What a language leaves out shows as the plugin wrote it:
// Traditional falls back to the Simplified copy first. Plugins without `i18n` work as before.
//
//   "i18n": {
//     "en": {
//       "display_name": "Notes",
//       "description": "Keeps notes in the workspace.",
//       "model_reason": "Summarizes notes",
//       "mock_description": "Sample notes",
//       "views": { "notebook": "Notebook" },
//       "commands": { "summarize": { "description": "Summarize a note", "argument_hint": "<note>" } },
//       "skills": { "tidy-notes": "Tidies the notes folder" }
//     }
//   }

/** The interface's languages (the desktop app's shared/i18n Locale). */
export type PluginLocale = 'zh-CN' | 'zh-TW' | 'en';
export const PLUGIN_LOCALES: readonly PluginLocale[] = ['zh-CN', 'zh-TW', 'en'];

/** One language's words. Every field is optional. */
export interface PluginTexts {
  displayName?: string;
  description?: string;
  /** permissions.model.reason */
  modelReason?: string;
  /** mock.description */
  mockDescription?: string;
  /** View id → title. */
  views?: Record<string, string>;
  /** Command id → its description and argument hint. */
  commands?: Record<string, { description?: string; argumentHint?: string }>;
  /** Skill id → its description. */
  skills?: Record<string, string>;
}

export type PluginI18n = Partial<Record<PluginLocale, PluginTexts>>;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Reads manifest.json · i18n. Never an error (a plugin must not fail to install over its translations): a part
 * that is not as described is left out with a warning.
 */
export function parseI18n(raw: unknown, warn: (path: string, message: string) => void): PluginI18n | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    warn('i18n', '「i18n」须为对象，例如 { "en": { "description": "…" } }，已忽略。');
    return undefined;
  }
  const out: PluginI18n = {};
  for (const [lang, v] of Object.entries(raw)) {
    if (!(PLUGIN_LOCALES as readonly string[]).includes(lang)) {
      warn(`i18n.${lang}`, `不支持的语言「${lang}」，可选：${PLUGIN_LOCALES.join('、')}，已忽略。`);
      continue;
    }
    if (!isObj(v)) {
      warn(`i18n.${lang}`, `「i18n.${lang}」须为对象，已忽略。`);
      continue;
    }
    const t: PluginTexts = {};
    const field = (key: string, set: (s: string) => void) => {
      if (v[key] === undefined) return;
      const s = text(v[key]);
      if (s) set(s);
      else warn(`i18n.${lang}.${key}`, `「${key}」须为文字，已忽略。`);
    };
    field('display_name', (s) => (t.displayName = s));
    field('description', (s) => (t.description = s));
    field('model_reason', (s) => (t.modelReason = s));
    field('mock_description', (s) => (t.mockDescription = s));
    const map = (key: 'views' | 'skills'): Record<string, string> | undefined => {
      const m = v[key];
      if (m === undefined) return undefined;
      if (!isObj(m) || Object.values(m).some((x) => !text(x))) {
        warn(`i18n.${lang}.${key}`, `「${key}」须为 { "id": "文字" }，已忽略。`);
        return undefined;
      }
      return Object.fromEntries(Object.entries(m).map(([k, x]) => [k, text(x)!]));
    };
    const views = map('views');
    if (views) t.views = views;
    const skills = map('skills');
    if (skills) t.skills = skills;
    const cmds = v.commands;
    if (cmds !== undefined) {
      if (!isObj(cmds) || Object.values(cmds).some((c) => !isObj(c))) warn(`i18n.${lang}.commands`, '「commands」须为 { "id": { "description": "…", "argument_hint": "…" } }，已忽略。');
      else {
        t.commands = {};
        for (const [id, c] of Object.entries(cmds as Record<string, Json>)) {
          const d = text(c.description);
          const h = text(c.argument_hint);
          t.commands[id] = { ...(d ? { description: d } : {}), ...(h ? { argumentHint: h } : {}) };
        }
      }
    }
    for (const k of Object.keys(v)) {
      if (!['display_name', 'description', 'model_reason', 'mock_description', 'views', 'commands', 'skills'].includes(k)) warn(`i18n.${lang}.${k}`, `未知字段「${k}」，已忽略。`);
    }
    out[lang as PluginLocale] = t;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Of an i18n (a manifest's, or one read from a source's index.json), the card's words only: name and description, text only. */
export function offerTexts(raw: unknown): PluginI18n | undefined {
  if (!isObj(raw)) return undefined;
  const out: PluginI18n = {};
  for (const lang of PLUGIN_LOCALES) {
    const v = raw[lang];
    if (!isObj(v)) continue;
    const name = text(v.displayName);
    const desc = text(v.description);
    if (name || desc) out[lang] = { ...(name ? { displayName: name } : {}), ...(desc ? { description: desc } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The copies to look in for a language, best first: Traditional falls back to Simplified. */
function copies(i18n: PluginI18n | undefined, locale: PluginLocale): PluginTexts[] {
  if (!i18n) return [];
  const order: PluginLocale[] = locale === 'zh-TW' ? ['zh-TW', 'zh-CN'] : [locale];
  return order.map((l) => i18n[l]).filter((t): t is PluginTexts => !!t);
}

/** One of a plugin's words in a language: the first copy that has it, else what the plugin wrote. */
export function pluginText(i18n: PluginI18n | undefined, locale: PluginLocale, pick: (t: PluginTexts) => string | undefined, written: string): string {
  for (const t of copies(i18n, locale)) {
    const v = pick(t);
    if (v) return v;
  }
  return written;
}

/** The parts of a plugin's description (describe()) that have words people read. */
export interface Localizable {
  displayName: string;
  description: string;
  skills: { id: string; description: string }[];
  commands: { id: string; description: string; argumentHint?: string }[];
  views: { id: string; title: string }[];
  model?: { reason: string };
  i18n?: PluginI18n;
}

/** A description (describe()) with its words in a language. */
export function localizeDescription<T extends Localizable>(d: T, locale: PluginLocale): T {
  const i = d.i18n;
  if (!i) return d;
  return {
    ...d,
    displayName: pluginText(i, locale, (t) => t.displayName, d.displayName),
    description: pluginText(i, locale, (t) => t.description, d.description),
    skills: d.skills.map((s) => ({ ...s, description: pluginText(i, locale, (t) => t.skills?.[s.id], s.description) })),
    commands: d.commands.map((c) => {
      const hint = c.argumentHint ? pluginText(i, locale, (t) => t.commands?.[c.id]?.argumentHint, c.argumentHint) : undefined;
      return { ...c, description: pluginText(i, locale, (t) => t.commands?.[c.id]?.description, c.description), ...(hint ? { argumentHint: hint } : {}) };
    }),
    views: d.views.map((v) => ({ ...v, title: pluginText(i, locale, (t) => t.views?.[v.id], v.title) })),
    ...(d.model ? { model: { ...d.model, reason: pluginText(i, locale, (t) => t.modelReason, d.model.reason) } } : {}),
  };
}

/** A page of a plugin (views()) with its title and its plugin's name in a language. */
export function localizeView<T extends { id: string; title: string; pluginTitle: string; i18n?: PluginI18n }>(v: T, locale: PluginLocale): T {
  if (!v.i18n) return v;
  return { ...v, title: pluginText(v.i18n, locale, (t) => t.views?.[v.id], v.title), pluginTitle: pluginText(v.i18n, locale, (t) => t.displayName, v.pluginTitle) };
}

/** A / command (commands()) with its description and hint in a language. `id` is the part after "plugin:". */
export function localizeCommand<T extends { name: string; plugin: string; description: string; argumentHint?: string; i18n?: PluginI18n }>(c: T, locale: PluginLocale): T {
  if (!c.i18n) return c;
  const id = c.name.slice(c.plugin.length + 1);
  const hint = c.argumentHint ? pluginText(c.i18n, locale, (t) => t.commands?.[id]?.argumentHint, c.argumentHint) : undefined;
  return { ...c, description: pluginText(c.i18n, locale, (t) => t.commands?.[id]?.description, c.description), ...(hint ? { argumentHint: hint } : {}) };
}

/** A plugin offered by a source (the marketplace card) with its name and description in a language. */
export function localizeOffer<T extends { name: string; displayName?: string; description?: string; i18n?: PluginI18n }>(e: T, locale: PluginLocale): T {
  if (!e.i18n) return e;
  const name = pluginText(e.i18n, locale, (t) => t.displayName, e.displayName ?? '');
  const desc = pluginText(e.i18n, locale, (t) => t.description, e.description ?? '');
  return { ...e, ...(name ? { displayName: name } : {}), ...(desc ? { description: desc } : {}) };
}
