// Words shared by 整理 (settings/Memory.tsx) and the box on a memory page (settings/MemoryAsk.tsx).
import type { MemoryCategory, MemoryItem, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';

/** A category's name on the page (its group's title, the entry's 类别). */
export const CATEGORY_LABEL: Record<MemoryCategory, string> = { you: '你', areas: '领域', topics: '主题', people: '人物', projects: '项目' };

const CHANGE_WORD: Record<MemoryTidyChange['action'], string> = { added: '新增', rewritten: '改写', merged: '合并', forgotten: '删除' };

/** A change of a tidy in words: 新增 / 改写 / 合并 / 删除 and the note, what it replaced in brackets; 已撤销 once taken back. */
export function tidyChangeText(c: MemoryTidyChange): string {
  const was = c.previous?.length ? `（原${c.previous.map((p) => `「${p.text}」`).join('')}）` : '';
  return c.undone ? `已撤销：${c.item.text}` : `${CHANGE_WORD[c.action]}：${c.item.text}${was}`;
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
