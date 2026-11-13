// 设置 › 记忆: the switch, 整理, and what the assistant remembers, grouped by category as Claude's memory page
// (你, 领域, 主题, 人物, 项目, each under its name, an empty one not shown; notes from before there were categories
// last, without a name, until a tidy gives them one), newest first in a group, one line each: the sentence cut to
// the line, when it last changed, a pencil and a bin at the right end without a box. A line (or the pencil) opens the note's own page in the list's place (as a plugin's page): ← 记忆 at the
// top left, the whole sentence with 编辑 and 删除, when it last changed, the conversation it was saved in and the
// user's words. 添加 opens the same kind of page with an empty box. Deleting and clearing are for good (the core
// drops the items and their older versions).
import { useEffect, useRef, useState } from 'react';
import type { MemoryCardMeta, MemoryCategory, MemoryItem, MemoryRefusal, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';
import { MEMORY_CATEGORIES } from '@spica/protocol';
import { Switch } from './Switch';
import { Group, Pane, Row } from './Group';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/Dialog';
import { fullTime, timeOf } from '../chat/format';
import { useEscape } from '../ui/escape';

/** A category's name on the page (its group's title, the page's 类别). */
export const CATEGORY_LABEL: Record<MemoryCategory, string> = { you: '你', areas: '领域', topics: '主题', people: '人物', projects: '项目' };

/** The most characters in one item (the core refuses longer ones). */
export const MEMORY_CHARS = 200;

export interface MemoryApi {
  add(text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  edit(id: number, text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
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

/** The groups of the list in order (你, 领域, 主题, 人物, 项目, then those without a category), the empty ones left out. */
export function memoryGroups(list: MemoryItem[]): { category: MemoryCategory | null; items: MemoryItem[] }[] {
  const groups = [...MEMORY_CATEGORIES, null].map((category) => ({ category, items: list.filter((m) => (m.category ?? null) === category) }));
  return groups.filter((g) => g.items.length > 0);
}


/** What the page shows: the list, one note's page (editing it or not), or the page that adds one. */
type View = { page: 'list' } | { page: 'item'; id: number; editing: boolean } | { page: 'new' };

export function Memory({ items, enabled, onEnabled, api, titleOf, onOpenSession, tidy }: MemoryProps) {
  const list = shownMemories(items);
  const [view, setView] = useState<View>({ page: 'list' });
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [clearing, setClearing] = useState(false);
  // Back on the list: the line of the note just left is brought into sight and focused.
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const top = useRef<HTMLElement>(null);
  // A note gone while its page is open (deleted, merged by a tidy, forgotten in a conversation): the list.
  const item = view.page === 'item' ? list.find((m) => m.id === view.id) : undefined;
  const page = view.page === 'item' && !item ? 'list' : view.page;
  const toList = (from?: number) => {
    setReturnTo(from ?? null);
    setView({ page: 'list' });
  };
  const open = (id: number, editing = false) => setView({ page: 'item', id, editing });
  // A page opens at its top (the list may have been scrolled down to the note).
  useEffect(() => {
    if (page !== 'list') top.current?.scrollIntoView?.({ block: 'start' });
  }, [page]);
  const dialogs = (
    <>
      {deleting ? (
        <ConfirmDialog
          title="删除这条记忆？"
          detail={deleting.text}
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void api.forget(deleting.id);
            if (view.page === 'item' && view.id === deleting.id) toList();
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
            setClearing(false);
          }}
        />
      ) : null}
    </>
  );
  if (view.page === 'item' && item) {
    return (
      <section ref={top} className="settings-section memory-detail" aria-label="记忆">
        <Back onBack={() => toList(item.id)} />
        <MemoryDetail
          item={item}
          editing={view.editing}
          title={item.sessionId ? titleOf(item.sessionId) : undefined}
          onOpenSession={onOpenSession}
          onEdit={(on) => open(item.id, on)}
          onSave={(text, category) => api.edit(item.id, text, category)}
          onDelete={() => setDeleting(item)}
        />
        {dialogs}
      </section>
    );
  }
  if (page === 'new') {
    return (
      <section ref={top} className="settings-section memory-detail" aria-label="添加记忆">
        <Back onBack={() => toList()} />
        <MemoryForm initial="" onCancel={() => toList()} onSave={(text, category) => api.add(text, category)} />
      </section>
    );
  }
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
      {/* 已记住 as a settings group (its title and buttons), a box per category under the category's name */}
      <div className="settings-group memory-known">
        <div className="group-head">
          <h3 className="settings-subheading">已记住</h3>
          <div className="group-actions">
            <button type="button" className="btn btn-small" onClick={() => setView({ page: 'new' })}>
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
        {list.length === 0 ? (
          <div className="group-box">
            <Pane>
              <p className="settings-hint memory-empty">暂无记忆</p>
            </Pane>
          </div>
        ) : (
          memoryGroups(list).map((g) => (
            <section key={g.category ?? 'none'} className="memory-section" {...(g.category ? { 'aria-label': CATEGORY_LABEL[g.category] } : {})}>
              {g.category ? <h4 className="memory-cat">{CATEGORY_LABEL[g.category]}</h4> : null}
              <div className="group-box">
                <ul className="memory-list group-list">
                  {g.items.map((m) => (
                    <MemoryRow
                      key={m.id}
                      item={m}
                      focus={returnTo === m.id}
                      onFocused={() => setReturnTo(null)}
                      onOpen={() => open(m.id)}
                      onEdit={() => open(m.id, true)}
                      onDelete={() => setDeleting(m)}
                    />
                  ))}
                </ul>
              </div>
            </section>
          ))
        )}
      </div>
      {dialogs}
    </section>
  );
}

/** ← 记忆 at the top left of a note's page (as ← 已安装 on a plugin's page). */
function Back({ onBack }: { onBack(): void }) {
  return (
    <button type="button" className="back-link memory-back" onClick={onBack}>
      <Icon name="arrowLeft" size={16} />
      记忆
    </button>
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
              <span className="memory-text" title={tidyChangeText(c)} data-tip-clipped="">
                {tidyChangeText(c)}
              </span>
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

/** A note in the list: one line (the sentence cut to it, whole on hover; the time), a pencil and a bin without a box. */
function MemoryRow({ item, focus, onFocused, onOpen, onEdit, onDelete }: { item: MemoryItem; focus: boolean; onFocused(): void; onOpen(): void; onEdit(): void; onDelete(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    onFocused();
  }, [focus, onFocused]);
  return (
    <li className="setting-row memory-row">
      <button ref={ref} type="button" className="memory-open" title={item.text} data-tip-clipped=".memory-text" onClick={onOpen}>
        <span className="memory-text">{item.text}</span>
        <span className="settings-hint memory-time">{timeOf(item.updatedAt)}</span>
      </button>
      <div className="memory-actions">
        <button type="button" className="icon-btn" aria-label="编辑" title="编辑" onClick={onEdit}>
          <Icon name="pencil" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label="删除" title="删除" onClick={onDelete}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  );
}

/** A note's page: the whole sentence with 编辑 and 删除 at the right (or the box editing it), then the facts. */
function MemoryDetail({
  item,
  editing,
  title,
  onOpenSession,
  onEdit,
  onSave,
  onDelete,
}: {
  item: MemoryItem;
  editing: boolean;
  /** The conversation it was saved in, by name; undefined when there is none (added here, or deleted). */
  title: string | undefined;
  onOpenSession(id: string, seq?: number): void;
  onEdit(on: boolean): void;
  onSave(text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  onDelete(): void;
}) {
  return (
    <>
      {editing ? (
        <MemoryForm initial={item.text} initialCategory={item.category} onCancel={() => onEdit(false)} onSave={onSave} />
      ) : (
        <header className="memory-detail-head">
          <h3 className="memory-detail-text">{item.text}</h3>
          <div className="memory-detail-actions">
            <button type="button" className="btn btn-small" onClick={() => onEdit(true)}>
              编辑
            </button>
            <button type="button" className="btn btn-small btn-quiet-danger" onClick={onDelete}>
              删除
            </button>
          </div>
        </header>
      )}
      <dl className="memory-facts">
        {item.category && !editing ? (
          <div className="memory-fact">
            <dt>类别</dt>
            <dd>{CATEGORY_LABEL[item.category]}</dd>
          </div>
        ) : null}
        <div className="memory-fact">
          <dt>最后修改</dt>
          <dd>{fullTime(item.updatedAt)}</dd>
        </div>
        {item.sessionId && title !== undefined ? (
          <div className="memory-fact">
            <dt>出处</dt>
            <dd>
              <button type="button" className="text-btn history-link" title="打开对话" onClick={() => onOpenSession(item.sessionId!, item.seq)}>
                {title}
              </button>
            </dd>
          </div>
        ) : null}
        {item.sessionId && item.quote ? (
          <div className="memory-fact">
            <dt>原话</dt>
            <dd className="memory-quote">{item.quote}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

/**
 * The box adding (initial '') or editing a note, its 类别 under it (one of five; none picked yet for a new note or
 * one from before there were categories), then 取消 and 保存. Esc cancels it (a layer).
 */
function MemoryForm({
  initial,
  initialCategory,
  onCancel,
  onSave,
}: {
  initial: string;
  initialCategory?: MemoryCategory | undefined;
  onCancel(): void;
  onSave(text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
}) {
  const [text, setText] = useState(initial);
  const [category, setCategory] = useState<MemoryCategory | undefined>(initialCategory);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = text.trim();
  const tooLong = value.length > MEMORY_CHARS;
  const unchanged = value === initial && category === initialCategory;
  const save = () => {
    if (!value || tooLong || unchanged || busy) return;
    setBusy(true);
    void onSave(value, category).then((r) => {
      setBusy(false);
      const no = refusal(r);
      if (no) setProblem(no);
      else if (r) onCancel();
    });
  };
  const shown = tooLong ? REFUSED.too_long : problem;
  // A layer of Esc: cancels the edit (or the adding), and only that (the settings stay open).
  useEscape(true, onCancel);
  return (
    <div className="memory-edit">
      <textarea
        className="input textarea memory-input"
        aria-label="记忆内容"
        rows={3}
        value={text}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      {shown ? <span className="field-error" role="alert">{shown}</span> : null}
      <div className="memory-pick">
        <span className="memory-pick-label">类别</span>
        <div className="segmented" role="radiogroup" aria-label="类别">
          {MEMORY_CATEGORIES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={category === c} className={category === c ? 'segment is-on' : 'segment'} onClick={() => setCategory(c)}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>
      <div className="memory-edit-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!value || tooLong || unchanged || busy} onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}
