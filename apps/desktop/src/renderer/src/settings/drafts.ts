// 设置里填到一半的东西：离开设置页、换标签、点别的模型再回来，还是你填的样子。
// 只放在这个窗口的内存里，不写盘（模型表单里可能有 API Key）；关掉 Spica 就没了。
import { useState } from 'react';

const kept = new Map<string, unknown>();

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 读一份留着的草稿（没有就是 undefined）。 */
export function keptDraft<T>(key: string): T | undefined {
  return kept.get(key) as T | undefined;
}

/** 留着一份草稿；和保存的一样时不留。 */
export function keepDraft<T>(key: string, value: T, saved: T): void {
  if (same(value, saved)) kept.delete(key);
  else kept.set(key, value);
}

/** 保存了或删掉了：草稿作废。 */
export function dropDraft(key: string): void {
  kept.delete(key);
}

/** 测试用。 */
export function dropAllDrafts(): void {
  kept.clear();
}

/**
 * 像 useState，但填了没保存的内容会留着，回来还在。
 * `saved` 是现在保存着的值：和它一样时不算草稿；保存后调 `done()`。
 */
export function useKeptDraft<T>(key: string, saved: T): [T, (value: T) => void, () => void] {
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : saved));
  const set = (next: T) => {
    setValue(next);
    keepDraft(key, next, saved);
  };
  const done = () => dropDraft(key);
  return [value, set, done];
}
