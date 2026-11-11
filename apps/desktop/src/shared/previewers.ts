// Which preview shows a file in the right panel: the app's own, or a plugin's preview page (views/<id>.json with
// placement preview) the user chose for that kind of file in 设置 › 常规 › 文件预览. Settings keep
// { ".docx": "<plugin>/<page id>" }; a choice whose page is gone (plugin removed or turned off) counts as the
// app's own, without changing the settings file.
import type { PluginView } from './plugin-view';

/** The app's own preview (no plugin). */
export const BUILT_IN = '';

/** The value kept in the settings for a page. */
export function previewerId(v: Pick<PluginView, 'plugin' | 'id'>): string {
  return `${v.plugin}/${v.id}`;
}

/** A file's kind as the settings and the pages name it: lower case, with the dot; '' for none. */
export function fileExtension(name: string): string {
  const m = /(\.[^.\\/]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Preview pages that can show this kind of file. */
export function previewPagesFor(ext: string, views: readonly PluginView[]): PluginView[] {
  return ext ? views.filter((v) => v.placement === 'preview' && v.preview?.extensions.includes(ext)) : [];
}

/** The page chosen for this kind of file, if it is still there; else null (the app's own). */
export function chosenPreviewPage(previewers: Record<string, string>, ext: string, views: readonly PluginView[]): PluginView | null {
  const id = previewers[ext];
  if (!id) return null;
  return previewPagesFor(ext, views).find((v) => previewerId(v) === id) ?? null;
}

/** The kinds of file 文件预览 lists: every one a page can show, and every one with a choice kept (its page may be gone). */
export function previewKinds(previewers: Record<string, string>, views: readonly PluginView[]): string[] {
  const kinds = new Set(Object.keys(previewers));
  for (const v of views) if (v.placement === 'preview') for (const e of v.preview?.extensions ?? []) kinds.add(e);
  return [...kinds].sort();
}

/** Settings value check: { ".ext": "plugin/page" }, anything else dropped. */
export function sanitizePreviewers(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [ext, id] of Object.entries(v as Record<string, unknown>)) {
    if (/^\.[a-z0-9]{1,16}$/.test(ext) && typeof id === 'string' && /^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(id)) out[ext] = id;
  }
  return out;
}
