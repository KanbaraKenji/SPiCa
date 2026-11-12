// 设置 › 记忆: the switch, what the assistant remembers (newest first), adding one, editing, deleting
// and clearing all. Deleting and clearing are for good (the core drops the items and their older versions).
import { useState } from 'react';
import type { MemoryCardMeta, MemoryItem, MemoryRefusal, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';
import { Switch } from './Switch';
import { Group, Pane, Row } from './Group';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/Dialog';
import { timeOf } from '../chat/format';

/** The most characters in one item (the core refuses longer ones). */
export const MEMORY_CHARS = 200;

export interface MemoryApi {
  add(text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  edit(id: number, text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  forget(id: number): Promise<unknown>;
  clear(): Promise<unknown>;
}

export interface MemoryProps {
  /** Every item (replaced and forgotten too); null until loaded. */
  items: MemoryItem[] | null;
  enabled: boolean;
  onEnabled(on: boolean): void;
  api: MemoryApi;
  /** The conversation an item was saved in, by name; undefined when it was deleted. */
  titleOf(sessionId: string): string | undefined;
  /** Opens the conversation at the user's message the item was saved from. */
  onOpenSession(id: string, seq?: number): void;
  /** 整理 (absent when the core does not tidy). */
  tidy?: MemoryTidy | undefined;
}

export interface MemoryTidy {
  /** The latest tidies, newest first; null until loaded. */
  runs: MemoryTidyRun[] | null;
  /** 自动整理 (a shell setting). */
  auto: boolean;
  onAuto(on: boolean): void;
  /** 立即整理: a problem in words, or null when it started. */
  run(): Promise<string | null>;
  /** 撤销 one change (index) or the whole tidy. */
  undo(id: number, change?: number): Promise<unknown>;
}

const CHANGE_WORD: Record<MemoryTidyChange['action'], string> = { added: '新增', rewritten: '改写', merged: '合并', forgotten: '删除' };

/** A change of a tidy in words: 新增 / 改写 / 合并 / 删除 and the note, what it replaced in brackets; 已撤销 once taken back. */
export function tidyChangeText(c: MemoryTidyChange): string {
  const was = c.previous?.length ? `（原${c.previous.map((p) => `「${p.text}」`).join('')}）` : '';
  return c.undone ? `已撤销：${c.item.text}` : `${CHANGE_WORD[c.action]}：${c.item.text}${was}`;
}

const REFUSED: Record<MemoryRefusal['refused'], string> = {
  empty: '内容为空，未保存',
  too_long: `超过 ${MEMORY_CHARS} 字，未保存`,
  secret: '疑似密码、密钥或证件号码，未保存',
};

const refusal = (r: MemoryCardMeta | MemoryRefusal | undefined): string | null => (r && 'refused' in r ? REFUSED[r.refused] : null);

/** The active items, the newest saved first. */
export function shownMemories(items: MemoryItem[] | null): MemoryItem[] {
  return (items ?? []).filter((m) => m.status === 'active').sort((a, b) => b.id - a.id);
}

export function Memory({ items, enabled, onEnabled, api, titleOf, onOpenSession, tidy }: MemoryProps) {
  const list = shownMemories(items);
  // One form open at a time: 'new' (添加) or the item being edited.
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [clearing, setClearing] = useState(false);
  return (
    <section className="settings-section memory-page">
      <Group>
        <Row title="启用记忆">
          <Switch on={enabled} label="启用记忆" onChange={onEnabled} />
        </Row>
        {tidy ? (
          <Row title="自动整理">
            <Switch on={tidy.auto} label="自动整理" disabled={!enabled} onChange={tidy.onAuto} />
          </Row>
        ) : null}
      </Group>
      {tidy ? <TidyGroup tidy={tidy} enabled={enabled} items={items} /> : null}
      <Group
        title="已记住"
        actions={
          <>
            <button type="button" className="btn btn-small" disabled={open === 'new'} onClick={() => setOpen('new')}>
              <Icon name="plus" size={14} />
              添加
            </button>
            {list.length ? (
              <button type="button" className="btn btn-small btn-quiet-danger" onClick={() => setClearing(true)}>
                全部清除
              </button>
            ) : null}
          </>
        }
      >
        {list.length === 0 && open !== 'new' ? (
          <Pane>
            <p className="settings-hint memory-empty">暂无记忆</p>
          </Pane>
        ) : (
          <ul className="memory-list group-list">
            {open === 'new' ? <MemoryForm key="new" initial="" onCancel={() => setOpen(null)} onSave={(text) => api.add(text)} /> : null}
            {list.map((m) =>
              open === m.id ? (
                <MemoryForm key={m.id} initial={m.text} quote={m.sessionId ? m.quote : undefined} onCancel={() => setOpen(null)} onSave={(text) => api.edit(m.id, text)} />
              ) : (
                <MemoryRow key={m.id} item={m} title={m.sessionId ? titleOf(m.sessionId) : undefined} onOpenSession={onOpenSession} onEdit={() => setOpen(m.id)} onDelete={() => setDeleting(m)} />
              ),
            )}
          </ul>
        )}
      </Group>
      {deleting ? (
        <ConfirmDialog
          title="删除这条记忆？"
          detail={deleting.text}
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void api.forget(deleting.id);
            if (open === deleting.id) setOpen(null);
            setDeleting(null);
          }}
        />
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title={`清除全部 ${list.length} 条记忆？`}
          confirmLabel="全部清除"
          danger
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            void api.clear();
            if (open !== 'new') setOpen(null);
            setClearing(false);
          }}
        />
      ) : null}
    </section>
  );
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

const summary = (r: MemoryTidyRun) => (r.status === 'failed' ? '整理失败' : r.changes.length ? `${r.changes.length} 条改动` : '无改动');

function TidyGroup({ tidy, enabled, items }: { tidy: MemoryTidy; enabled: boolean; items: MemoryItem[] | null }) {
  const [problem, setProblem] = useState<string | null>(null);
  const last = tidy.runs?.[0];
  const running = last?.status === 'running';
  // the changes shown are the latest tidy's that changed something (a later one with nothing to change does not hide them)
  const shown = tidy.runs?.find((r) => r.status === 'done' && r.changes.length > 0);
  const open = shown ? shown.changes.some((c) => changeStands(c, shown, items)) : false;
  return (
    <Group
      title="整理"
      after={problem ? <p className="provider-result is-bad group-note" role="alert">{problem}</p> : null}
      actions={
        <>
          {open && shown ? (
            <button type="button" className="btn btn-small" onClick={() => void tidy.undo(shown.id)}>
              全部撤销
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-small"
            disabled={!enabled || running}
            onClick={() => {
              setProblem(null);
              void tidy.run().then(setProblem);
            }}
          >
            {running ? '整理中' : '立即整理'}
          </button>
        </>
      }
    >
      {/* the latest tidy as a row of the box: its name, when and what it changed in grey (as every row's grey line) */}
      <Row
        title="最近一次"
        className="memory-tidy-last"
        hint={
          <>
            {last && last.status !== 'running' ? `${timeOf(last.endedAt ?? last.startedAt)} · ${summary(last)}` : last ? '整理中' : '—'}
            {shown && shown !== last ? <span className="memory-tidy-shown">{`${timeOf(shown.endedAt ?? shown.startedAt)} · ${summary(shown)}`}</span> : null}
          </>
        }
      />
      {shown ? (
        <ul className="memory-list memory-tidy-list group-list">
          {shown.changes.map((c, i) => (
            <li key={`${shown.id}-${i}`} className="setting-row memory-tidy-change">
              <span className="memory-text">{tidyChangeText(c)}</span>
              {changeStands(c, shown, items) ? (
                <button type="button" className="btn btn-small memory-undo" onClick={() => void tidy.undo(shown.id, i)}>
                  撤销
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Group>
  );
}

function MemoryRow({ item, title, onOpenSession, onEdit, onDelete }: { item: MemoryItem; title: string | undefined; onOpenSession(id: string, seq?: number): void; onEdit(): void; onDelete(): void }) {
  return (
    <li className="setting-row memory-row">
      <div className="setting-text">
        <span className="memory-text">{item.text}</span>
        <span className="settings-hint memory-meta">
          {timeOf(item.updatedAt)}
          {item.sessionId && title !== undefined ? (
            <span className="memory-from">
              <span className="memory-sep">·</span>
              <button type="button" className="text-btn history-link" title="打开对话" onClick={() => onOpenSession(item.sessionId!, item.seq)}>
                {title}
              </button>
            </span>
          ) : null}
        </span>
      </div>
      {/* square icon buttons as elsewhere in the settings (删除 as 模型 › 服务商 and 插件来源: the quiet red) */}
      <div className="memory-actions">
        <button type="button" className="btn btn-small btn-square" aria-label="编辑" title="编辑" onClick={onEdit}>
          <Icon name="pencil" size={14} />
        </button>
        <button type="button" className="btn btn-small btn-quiet-danger btn-square" aria-label="删除" title="删除" onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </li>
  );
}

/** Adding (initial '') or editing an item in place; `quote`: the user's words it was saved from (not for one added here). */
function MemoryForm({ initial, quote, onCancel, onSave }: { initial: string; quote?: string | undefined; onCancel(): void; onSave(text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined> }) {
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = text.trim();
  const tooLong = value.length > MEMORY_CHARS;
  const save = () => {
    if (!value || tooLong || value === initial || busy) return;
    setBusy(true);
    void onSave(value).then((r) => {
      setBusy(false);
      const no = refusal(r);
      if (no) setProblem(no);
      else if (r) onCancel();
    });
  };
  const shown = tooLong ? REFUSED.too_long : problem;
  return (
    <li className="setting-row memory-row is-editing">
      <div className="memory-edit">
        <textarea
          className="input textarea memory-input"
          aria-label="记忆内容"
          rows={2}
          value={text}
          autoFocus
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onCancel();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            }
          }}
        />
        {shown ? <span className="field-error" role="alert">{shown}</span> : null}
        {quote ? <span className="settings-hint memory-quote">原话：「{quote}」</span> : null}
        <div className="memory-edit-actions">
          <button type="button" className="btn btn-small" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-small btn-primary" disabled={!value || tooLong || value === initial || busy} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </li>
  );
}
