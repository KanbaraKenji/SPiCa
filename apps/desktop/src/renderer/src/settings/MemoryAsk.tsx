// The box at the bottom of an entry's page (and of a note's page, for a note in no entry), as Claude's memory pages
// have it: a sentence for the model to change this entry (its summary, name, category, details; a detail moved to
// another entry, or put in one). Above the box, what the latest sentence did: one line per change as 整理 writes
// them, each with 撤销, or what the model said when it could not; while it runs the arrow is 停止.
import { useState } from 'react';
import type { MemoryEntry, MemoryItem, MemoryTidyRun } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { t } from '../../../shared/i18n';
import { CATEGORY_LABEL, changeStands, tidyChangeText } from './memory-tidy-text';

export interface MemoryAsk {
  /** The latest sentences, newest first; null until loaded. */
  runs: MemoryTidyRun[] | null;
  /** Sends a sentence: a problem in words, or null when it started. */
  send(target: { entry: number } | { item: number }, text: string): Promise<string | null>;
  stop(id: number): Promise<unknown>;
  /** 撤销 one change (index) or the whole run. */
  undo(id: number, change?: number): Promise<unknown>;
  /** No model is set up: the box is off and says so. */
  noModel?: boolean;
}

/** The page a run belongs to: the one it was typed on, or an entry it moved something into. */
export function askFor(runs: MemoryTidyRun[] | null, page: { entry: number } | { item: number }): MemoryTidyRun | undefined {
  return (runs ?? []).find((r) =>
    'entry' in page ? r.ask?.entry === page.entry || (r.grouped ?? []).some((g) => g.entry === page.entry) : r.ask?.item === page.item,
  );
}

/** One line of what a sentence did: the change's index when 撤销 can take that change back alone. */
export interface AskLine {
  text: string;
  change?: number;
  /** It is still as the sentence left it (so 全部撤销 has something to take back). */
  stands: boolean;
}

/** What a sentence did in words, as the memory is now (what was undone or changed since says so, or is left out). */
export function askLines(run: MemoryTidyRun, items: MemoryItem[] | null, entries: MemoryEntry[] | null): AskLine[] {
  const lines: AskLine[] = [];
  run.changes.forEach((c, i) => {
    const still = changeStands(c, run, items);
    lines.push({ text: tidyChangeText(c), stands: still, ...(still ? { change: i } : {}) });
  });
  for (const done of run.entries ?? []) {
    const e = entries?.find((x) => x.id === done.entry && x.updatedAt === done.at);
    if (!e) continue;
    if (!done.before) {
      lines.push({ text: t('新建「{name}」', { name: e.name }), stands: true });
      continue;
    }
    if (done.before.name !== e.name) lines.push({ text: t('名字改为「{name}」', { name: e.name }), stands: true });
    if (done.before.category !== e.category && e.category) lines.push({ text: t('类别改为「{category}」', { category: t(CATEGORY_LABEL[e.category]) }), stands: true });
    if (done.before.summary !== e.summary) lines.push({ text: t('更新摘要「{name}」：{summary}', { name: e.name, summary: e.summary }), stands: true });
  }
  for (const g of run.grouped ?? []) {
    const it = items?.find((m) => m.id === g.item && m.status === 'active' && m.entryId === g.entry);
    const e = entries?.find((x) => x.id === g.entry);
    if (it && e) lines.push({ text: g.from !== undefined ? t('移到「{name}」：{text}', { name: e.name, text: it.text }) : t('归入「{name}」：{text}', { name: e.name, text: it.text }), stands: true });
  }
  return lines;
}

export function MemoryAskBox({
  ask,
  target,
  off,
  items,
  entries,
  shown,
}: {
  ask: MemoryAsk;
  target: { entry: number } | { item: number };
  /** Why the box cannot be used now (记忆已关闭, 还没有配置模型), or null. */
  off: string | null;
  items: MemoryItem[] | null;
  entries: MemoryEntry[] | null;
  /** The run to show above the box (the latest for this page). */
  shown: MemoryTidyRun | undefined;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const running = shown?.status === 'running' ? shown : (ask.runs ?? []).find((r) => r.status === 'running');
  const mine = running && shown && running.id === shown.id;
  const send = () => {
    const said = text.trim();
    if (!said || off || running) return;
    setProblem(null);
    void ask.send(target, said).then((p) => {
      if (p) setProblem(p);
      else setText('');
    });
  };
  return (
    <div className="memory-ask">
      {shown ? <AskResult run={shown} ask={ask} items={items} entries={entries} /> : null}
      {off || problem ? (
        <p className={off ? 'settings-hint memory-ask-off' : 'provider-result is-bad memory-ask-off'} role={off ? undefined : 'alert'}>
          {off ?? problem}
        </p>
      ) : null}
      <form
        className="memory-ask-box"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="input memory-ask-input"
          value={text}
          disabled={Boolean(off)}
          placeholder={t('要改什么')}
          aria-label={t('要改什么')}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        {mine ? (
          <button type="button" className="icon-btn composer-stop memory-ask-send" onClick={() => void ask.stop(running.id)} aria-label={t('停止')} title={t('停止')}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="submit" className="icon-btn composer-send memory-ask-send" disabled={Boolean(off) || !text.trim() || Boolean(running)} aria-label={t('发送')} title={t('发送')}>
            <Icon name="send" size={16} />
          </button>
        )}
      </form>
    </div>
  );
}

/** What the latest sentence did: its sentence in grey, then a line per change with 撤销, or the model's words. */
export function AskResult({ run, ask, items, entries }: { run: MemoryTidyRun; ask: MemoryAsk; items: MemoryItem[] | null; entries: MemoryEntry[] | null }) {
  const lines = run.status === 'done' ? askLines(run, items, entries) : [];
  const reply = run.ask?.reply?.trim();
  return (
    <div className="memory-ask-result" role="status">
      <div className="memory-ask-said">
        <span className="settings-hint memory-ask-text" title={run.ask?.text} data-tip-clipped="">
          {run.ask?.text}
        </span>
        {run.status === 'running' ? <span className="settings-hint">{t('修改中')}</span> : null}
        {lines.some((l) => l.stands) ? (
          <button type="button" className="btn btn-small memory-undo" onClick={() => void ask.undo(run.id)}>
            {t('全部撤销')}
          </button>
        ) : null}
      </div>
      {run.status === 'failed' ? <p className="provider-result is-bad">{run.error || t('修改失败')}</p> : null}
      {lines.length ? (
        <ul className="memory-list memory-tidy-list group-list">
          {lines.map((l, i) => (
            <li key={`${run.id}-${i}`} className="setting-row memory-tidy-change">
              <span className="memory-text" title={l.text} data-tip-clipped="">
                {l.text}
              </span>
              {l.change !== undefined ? (
                <button type="button" className="btn btn-small memory-undo" onClick={() => void ask.undo(run.id, l.change)}>
                  {t('撤销')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {reply ? <p className="memory-ask-reply">{reply}</p> : null}
      {run.status === 'done' && !lines.length && !reply ? <p className="settings-hint memory-ask-reply">{t('没有改动')}</p> : null}
    </div>
  );
}
