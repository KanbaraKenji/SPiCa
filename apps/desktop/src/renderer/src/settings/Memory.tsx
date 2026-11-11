// 设置 › 记忆: the switch, what the assistant remembers (newest first), adding one, editing, deleting
// and clearing all. Items are never deleted in the core: a deleted one is kept as forgotten.
import { useState } from 'react';
import type { MemoryCardMeta, MemoryItem, MemoryRefusal } from '@spica/protocol';
import { Switch } from './Switch';
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

export function Memory({ items, enabled, onEnabled, api, titleOf, onOpenSession }: MemoryProps) {
  const list = shownMemories(items);
  // One form open at a time: 'new' (添加) or the item being edited.
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [clearing, setClearing] = useState(false);
  return (
    <section className="settings-section memory-page">
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">启用记忆</span>
          </div>
          <Switch on={enabled} label="启用记忆" onChange={onEnabled} />
        </div>
      </div>
      <div className="settings-group">
        <div className="memory-head">
          <h3 className="settings-subheading">已记住</h3>
          <div className="memory-head-actions">
            <button type="button" className="btn btn-small" disabled={open === 'new'} onClick={() => setOpen('new')}>
              <Icon name="plus" size={14} />
              添加
            </button>
            {list.length ? (
              <button type="button" className="btn btn-small btn-quiet-danger" onClick={() => setClearing(true)}>
                全部清除
              </button>
            ) : null}
          </div>
        </div>
        {list.length === 0 && open !== 'new' ? (
          <p className="settings-hint memory-empty">暂无记忆</p>
        ) : (
          <ul className="memory-list">
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
      </div>
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
      <div className="memory-actions">
        <button type="button" className="icon-btn" aria-label="编辑" title="编辑" onClick={onEdit}>
          <Icon name="pencil" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="删除" title="删除" onClick={onDelete}>
          <Icon name="trash" size={15} />
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
