// Words shared by 整理 (settings/Memory.tsx) and the box on a memory page (settings/MemoryAsk.tsx).
import type { MemoryCategory, MemoryItem, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';
import { getLocale, N_, t } from '../../../shared/i18n';

/** A category's name on the page (its group's title, the entry's 类别): a key, shown with t(). */
export const CATEGORY_LABEL: Record<MemoryCategory, string> = { you: N_('你|category'), areas: N_('领域'), topics: N_('主题'), people: N_('人物'), projects: N_('项目|category') };

const CHANGE_WORD: Record<MemoryTidyChange['action'], string> = { added: N_('新增|change'), rewritten: N_('改写|change'), merged: N_('合并|change'), forgotten: N_('删除|change') };

/** A change of a tidy in words: 新增 / 改写 / 合并 / 删除 and the note, what it replaced in brackets; 已撤销 once taken back. */
export function tidyChangeText(c: MemoryTidyChange): string {
  if (c.undone) return t('已撤销：{text}', { text: c.item.text });
  const action = t(CHANGE_WORD[c.action]);
  if (!c.previous?.length) return t('{action}：{text}', { action, text: c.item.text });
  // the notes it replaced, each in quotes (side by side in Chinese, a space between in English)
  const was = c.previous.map((p) => t('「{name}」', { name: p.text })).join(getLocale() === 'en' ? ' ' : '');
  return t('{action}：{text}（原{was}）', { action, text: c.item.text, was });
}

/**
 * Whether a change of a tidy still stands (so 撤销 can take it back): the note it made is still in the memory, or
 * the note it forgot is still forgotten. Unknown items count as standing.
 */
export function changeStands(c: MemoryTidyChange, run: MemoryTidyRun, items: MemoryItem[] | null): boolean {
  if (c.undone) return false;
  if (!items) return true;
  const now = items.find((m) => m.id === c.item.id);
  return c.action === 'forgotten' ? now?.status === 'forgotten' && !now.undone && now.tidyId === run.id : now?.status === 'active';
}
