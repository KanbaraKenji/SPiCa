// 设置 › 记忆: the switch, 整理, and what the assistant remembers, as Claude's memory page. The memory is kept in
// entries (a name, a summary, a category; its details are the notes). 已记住 groups the entries by category (你, 领域,
// 主题, 人物, 项目, each under its name, an empty one not shown; notes in no entry yet, from before there were
// entries, last without a name until a tidy puts them in one), newest first, one line each: the name, the summary in
// grey cut to the line, when it last changed, a pencil and a bin without a box. A line opens the entry's page in the
// list's place (as a plugin's page): ← 记忆, the name with 编辑 and 删除, 类别, 最后修改, 摘要 and 详情 (a bulleted
// list). A detail opens its own page: ← the entry's name, the sentence with 编辑 and 删除, when it last changed,
// the conversation it was saved in and the user's words. 添加 makes an entry with its first detail; 添加 under
// 详情 adds a detail. Deleting and clearing are for good (the core drops the notes and their older versions).
import { useEffect, useRef, useState } from 'react';
import type { MemoryCardMeta, MemoryCategory, MemoryEntry, MemoryEntryInput, MemoryItem, MemoryRefusal, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';
import { MEMORY_CATEGORIES } from '@spica/protocol';
import { Switch } from './Switch';
import { Group, Pane, Row } from './Group';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/Dialog';
import { fullTime, timeOf } from '../chat/format';
import { useEscape } from '../ui/escape';

/** A category's name on the page (its group's title, the entry's 类别). */
export const CATEGORY_LABEL: Record<MemoryCategory, string> = { you: '你', areas: '领域', topics: '主题', people: '人物', projects: '项目' };

/** The most characters in one detail, an entry's name and its summary (the core refuses longer ones). */
export const MEMORY_CHARS = 200;
export const NAME_CHARS = 30;
export const SUMMARY_CHARS = 120;

export interface MemoryApi {
  /** A detail: to the entry (its id), or to a new entry. */
  add(text: string, entry: number | MemoryEntryInput): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  edit(id: number, text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  editEntry(id: number, entry: MemoryEntryInput): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  forget(id: number): Promise<unknown>;
  deleteEntry(id: number): Promise<unknown>;
  clear(): Promise<unknown>;
}

export interface MemoryProps {
  /** Every item (replaced and forgotten too); null until loaded. */
  items: MemoryItem[] | null;
  /** The entries with an active detail; null until loaded. */
  entries: MemoryEntry[] | null;
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
  name_taken: '名字已被使用，未保存',
};

const FIELD_REFUSED: Record<'name' | 'summary', Record<MemoryRefusal['refused'], string>> = {
  name: { empty: '名字为空，未保存', too_long: `名字超过 ${NAME_CHARS} 字，未保存`, secret: '名字疑似密码、密钥或证件号码，未保存', name_taken: '名字已被使用，未保存' },
  summary: { empty: '摘要为空，未保存', too_long: `摘要超过 ${SUMMARY_CHARS} 字，未保存`, secret: '摘要疑似密码、密钥或证件号码，未保存', name_taken: '名字已被使用，未保存' },
};

const refusal = (r: MemoryCardMeta | MemoryRefusal | undefined): string | null => (r && 'refused' in r ? (r.field ? FIELD_REFUSED[r.field][r.refused] : REFUSED[r.refused]) : null);

/** The active items, the newest saved first. */
export function shownMemories(items: MemoryItem[] | null): MemoryItem[] {
  return (items ?? []).filter((m) => m.status === 'active').sort((a, b) => b.id - a.id);
}

/** An entry with its active details (oldest first) and when it or one of them last changed. */
export interface EntryView {
  entry: MemoryEntry;
  details: MemoryItem[];
  at: string;
}

/** A line of 已记住: an entry, or a note in no entry. */
export type MemoryLine = { kind: 'entry'; view: EntryView } | { kind: 'note'; item: MemoryItem };

/** The entries with their details, and the notes in no entry (none named, or the entry gone). */
export function memoryViews(items: MemoryItem[] | null, entries: MemoryEntry[] | null): { views: EntryView[]; loose: MemoryItem[] } {
  const active = shownMemories(items);
  const views = (entries ?? [])
    .map((entry) => {
      const details = active.filter((m) => m.entryId === entry.id).sort((a, b) => a.id - b.id);
      const at = details.reduce((t, m) => (m.updatedAt > t ? m.updatedAt : t), entry.updatedAt);
      return { entry, details, at };
    })
    .filter((v) => v.details.length > 0);
  const known = new Set(views.map((v) => v.entry.id));
  return { views, loose: active.filter((m) => m.entryId === undefined || !known.has(m.entryId)) };
}

/**
 * The groups of 已记住 in order (你, 领域, 主题, 人物, 项目, then entries without a category and the notes in no entry,
 * without a name), the empty ones left out; newest first in a group.
 */
export function memoryGroups(views: EntryView[], loose: MemoryItem[]): { category: MemoryCategory | null; lines: MemoryLine[] }[] {
  const newest = (a: EntryView, b: EntryView) => b.at.localeCompare(a.at);
  const groups = MEMORY_CATEGORIES.map((category) => ({
    category: category as MemoryCategory | null,
    lines: views
      .filter((v) => v.entry.category === category)
      .sort(newest)
      .map((view): MemoryLine => ({ kind: 'entry', view })),
  }));
  groups.push({
    category: null,
    lines: [...views.filter((v) => !v.entry.category).sort(newest).map((view): MemoryLine => ({ kind: 'entry', view })), ...loose.map((item): MemoryLine => ({ kind: 'note', item }))],
  });
  return groups.filter((g) => g.lines.length > 0);
}

/**
 * What the page shows: the list, an entry's page (editing it or not), a detail's page (editing it or not), the page
 * making an entry, or the one adding a detail to an entry.
 */
type View =
  | { page: 'list' }
  | { page: 'entry'; id: number; editing: boolean }
  | { page: 'item'; id: number; editing: boolean }
  | { page: 'new' }
  | { page: 'add'; entry: number };

/** What the delete dialog is about. */
type Deleting = { kind: 'item'; item: MemoryItem } | { kind: 'entry'; view: EntryView };

export function Memory({ items, entries, enabled, onEnabled, api, titleOf, onOpenSession, tidy }: MemoryProps) {
  const { views, loose } = memoryViews(items, entries);
  const count = views.length + loose.length;
  const [view, setView] = useState<View>({ page: 'list' });
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [clearing, setClearing] = useState(false);
  // Back on the list (or the entry's page): the line just left is brought into sight and focused.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const top = useRef<HTMLElement>(null);
  // What a page shows, gone while it is open (deleted, merged by a tidy, forgotten in a conversation): the list.
  const entryView = view.page === 'entry' || view.page === 'add' ? views.find((v) => v.entry.id === (view.page === 'entry' ? view.id : view.entry)) : undefined;
  const item = view.page === 'item' ? shownMemories(items).find((m) => m.id === view.id) : undefined;
  const home = item?.entryId !== undefined ? views.find((v) => v.entry.id === item.entryId) : undefined;
  const page = (view.page === 'entry' || view.page === 'add') && !entryView ? 'list' : view.page === 'item' && !item ? 'list' : view.page;
  const toList = (from?: string) => {
    setReturnTo(from ?? null);
    setView({ page: 'list' });
  };
  const openEntry = (id: number, editing = false, from?: string) => {
    setReturnTo(from ?? null);
    setView({ page: 'entry', id, editing });
  };
  const openItem = (id: number, editing = false) => setView({ page: 'item', id, editing });
  // A page opens at its top (the list may have been scrolled down to the line).
  useEffect(() => {
    if (page !== 'list') top.current?.scrollIntoView?.({ block: 'start' });
  }, [page, view]);
  const dialogs = (
    <>
      {deleting ? (
        <ConfirmDialog
          title={deleting.kind === 'entry' ? `删除「${deleting.view.entry.name}」？` : '删除这条记忆？'}
          detail={deleting.kind === 'entry' ? `${deleting.view.details.length} 条详情` : deleting.item.text}
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting.kind === 'entry') {
              void api.deleteEntry(deleting.view.entry.id);
              toList();
            } else {
              const it = deleting.item;
              void api.forget(it.id);
              // the detail's page goes back to its entry (the list when it was the last one)
              if (view.page === 'item' && view.id === it.id) {
                const v = it.entryId !== undefined ? views.find((x) => x.entry.id === it.entryId) : undefined;
                if (v && v.details.length > 1) openEntry(v.entry.id);
                else toList();
              }
            }
            setDeleting(null);
          }}
        />
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title={`清除全部 ${count} 条记忆？`}
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
  if (page === 'item' && item) {
    const back = home ? () => openEntry(home.entry.id, false, `item-${item.id}`) : () => toList(`note-${item.id}`);
    return (
      <section ref={top} className="settings-section memory-detail" aria-label="记忆">
        <Back label={home ? home.entry.name : '记忆'} onBack={back} />
        <MemoryDetail
          item={item}
          editing={view.page === 'item' && view.editing}
          title={item.sessionId ? titleOf(item.sessionId) : undefined}
          onOpenSession={onOpenSession}
          onEdit={(on) => openItem(item.id, on)}
          onSave={(text) => api.edit(item.id, text)}
          onDelete={() => setDeleting({ kind: 'item', item })}
        />
        {dialogs}
      </section>
    );
  }
  if (page === 'entry' && entryView && view.page === 'entry') {
    const e = entryView.entry;
    return (
      <section ref={top} className="settings-section memory-detail" aria-label={e.name}>
        <Back label="记忆" onBack={() => toList(`entry-${e.id}`)} />
        <EntryDetail
          view={entryView}
          editing={view.editing}
          focus={returnTo}
          onFocused={() => setReturnTo(null)}
          onEdit={(on) => openEntry(e.id, on)}
          onSave={(input) => api.editEntry(e.id, input)}
          onDelete={() => setDeleting({ kind: 'entry', view: entryView })}
          onOpenItem={(id) => openItem(id)}
          onAdd={() => setView({ page: 'add', entry: e.id })}
        />
        {dialogs}
      </section>
    );
  }
  if (page === 'add' && entryView) {
    const e = entryView.entry;
    return (
      <section ref={top} className="settings-section memory-detail" aria-label="添加详情">
        <Back label={e.name} onBack={() => openEntry(e.id)} />
        <DetailForm initial="" onCancel={() => openEntry(e.id)} onSave={(text) => api.add(text, e.id)} />
      </section>
    );
  }
  if (page === 'new') {
    return (
      <section ref={top} className="settings-section memory-detail" aria-label="添加记忆">
        <Back label="记忆" onBack={() => toList()} />
        <EntryForm onCancel={() => toList()} onSave={(input, text) => api.add(text ?? '', input)} />
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
      {tidy ? <TidyGroup tidy={tidy} enabled={enabled} items={items} entries={entries} /> : null}
      {/* 已记住 as a settings group (its title and buttons), a box per category under the category's name */}
      <div className="settings-group memory-known">
        <div className="group-head">
          <h3 className="settings-subheading">已记住</h3>
          <div className="group-actions">
            <button type="button" className="btn btn-small" onClick={() => setView({ page: 'new' })}>
              <Icon name="plus" size={14} />
              添加
            </button>
            {count ? (
              <button type="button" className="btn btn-small btn-quiet-danger" onClick={() => setClearing(true)}>
                全部清除
              </button>
            ) : null}
          </div>
        </div>
        {count === 0 ? (
          <div className="group-box">
            <Pane>
              <p className="settings-hint memory-empty">暂无记忆</p>
            </Pane>
          </div>
        ) : (
          memoryGroups(views, loose).map((g) => (
            <section key={g.category ?? 'none'} className="memory-section" {...(g.category ? { 'aria-label': CATEGORY_LABEL[g.category] } : {})}>
              {g.category ? <h4 className="memory-cat">{CATEGORY_LABEL[g.category]}</h4> : null}
              <div className="group-box">
                <ul className="memory-list group-list">
                  {g.lines.map((line) => {
                    const key = line.kind === 'entry' ? `entry-${line.view.entry.id}` : `note-${line.item.id}`;
                    return line.kind === 'entry' ? (
                      <MemoryRow
                        key={key}
                        name={line.view.entry.name}
                        text={line.view.entry.summary}
                        at={line.view.at}
                        focus={returnTo === key}
                        onFocused={() => setReturnTo(null)}
                        onOpen={() => openEntry(line.view.entry.id)}
                        onEdit={() => openEntry(line.view.entry.id, true)}
                        onDelete={() => setDeleting({ kind: 'entry', view: line.view })}
                      />
                    ) : (
                      <MemoryRow
                        key={key}
                        text={line.item.text}
                        at={line.item.updatedAt}
                        focus={returnTo === key}
                        onFocused={() => setReturnTo(null)}
                        onOpen={() => openItem(line.item.id)}
                        onEdit={() => openItem(line.item.id, true)}
                        onDelete={() => setDeleting({ kind: 'item', item: line.item })}
                      />
                    );
                  })}
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

/** ← 记忆 (or ← the entry's name) at the top left of a page (as ← 已安装 on a plugin's page). */
function Back({ label, onBack }: { label: string; onBack(): void }) {
  return (
    <button type="button" className="back-link memory-back" onClick={onBack}>
      <Icon name="arrowLeft" size={16} />
      {label}
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

/** What a tidy did in words: its changes, and the notes it put into entries. */
const summary = (r: MemoryTidyRun) => {
  if (r.status === 'failed') return '整理失败';
  const parts = [...(r.changes.length ? [`${r.changes.length} 条改动`] : []), ...(r.grouped?.length ? [`归入 ${r.grouped.length} 条`] : [])];
  return parts.length ? parts.join('，') : '无改动';
};

/** The notes a tidy put into entries that are still there: the note and the entry's name (one gone since is left out). */
export function groupedNow(run: MemoryTidyRun, items: MemoryItem[] | null, entries: MemoryEntry[] | null): { text: string; name: string }[] {
  return (run.grouped ?? []).flatMap((g) => {
    const it = items?.find((m) => m.id === g.item && m.status === 'active' && m.entryId === g.entry);
    const e = entries?.find((x) => x.id === g.entry);
    return it && e ? [{ text: it.text, name: e.name }] : [];
  });
}

function TidyGroup({ tidy, enabled, items, entries }: { tidy: MemoryTidy; enabled: boolean; items: MemoryItem[] | null; entries: MemoryEntry[] | null }) {
  const [problem, setProblem] = useState<string | null>(null);
  const last = tidy.runs?.[0];
  const running = last?.status === 'running';
  // the changes shown are the latest tidy's that changed something (a later one with nothing to change does not hide them)
  const shown = tidy.runs?.find((r) => r.status === 'done' && (r.changes.length > 0 || (r.grouped?.length ?? 0) > 0));
  const grouped = shown ? groupedNow(shown, items, entries) : [];
  const open = shown ? shown.changes.some((c) => changeStands(c, shown, items)) || grouped.length > 0 : false;
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
          {grouped.map((g, i) => (
            <li key={`${shown.id}-g${i}`} className="setting-row memory-tidy-change">
              <span className="memory-text" title={`归入「${g.name}」：${g.text}`} data-tip-clipped="">
                {`归入「${g.name}」：${g.text}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Group>
  );
}

/**
 * A line of 已记住: an entry (its name, then its summary in grey) or a note in no entry (the sentence), cut to the
 * line and whole on hover; the time; a pencil and a bin without a box.
 */
function MemoryRow({
  name,
  text,
  at,
  focus,
  onFocused,
  onOpen,
  onEdit,
  onDelete,
}: {
  name?: string;
  text: string;
  at: string;
  focus: boolean;
  onFocused(): void;
  onOpen(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    onFocused();
  }, [focus, onFocused]);
  const whole = name ? `${name}：${text}` : text;
  return (
    <li className="setting-row memory-row">
      <button ref={ref} type="button" className="memory-open" title={whole} data-tip-clipped=".memory-text" onClick={onOpen}>
        {name ? <span className="memory-name">{name}</span> : null}
        <span className={name ? 'memory-text memory-summary' : 'memory-text'}>{text}</span>
        <span className="settings-hint memory-time">{timeOf(at)}</span>
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

/** An entry's page: the name with 编辑 and 删除 at the right (or the boxes editing it), then 类别, 最后修改, 摘要 and 详情. */
function EntryDetail({
  view,
  editing,
  focus,
  onFocused,
  onEdit,
  onSave,
  onDelete,
  onOpenItem,
  onAdd,
}: {
  view: EntryView;
  editing: boolean;
  /** The detail line to focus (coming back from its page). */
  focus: string | null;
  onFocused(): void;
  onEdit(on: boolean): void;
  onSave(input: MemoryEntryInput): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  onDelete(): void;
  onOpenItem(id: number): void;
  onAdd(): void;
}) {
  const e = view.entry;
  return (
    <>
      {editing ? (
        <EntryForm initial={e} onCancel={() => onEdit(false)} onSave={(input) => onSave(input)} />
      ) : (
        <header className="memory-detail-head">
          <h3 className="memory-detail-text">{e.name}</h3>
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
        {e.category && !editing ? (
          <div className="memory-fact">
            <dt>类别</dt>
            <dd>{CATEGORY_LABEL[e.category]}</dd>
          </div>
        ) : null}
        <div className="memory-fact">
          <dt>最后修改</dt>
          <dd>{fullTime(view.at)}</dd>
        </div>
        {!editing ? (
          <div className="memory-fact">
            <dt>摘要</dt>
            <dd className="memory-quote">{e.summary}</dd>
          </div>
        ) : null}
        <div className="memory-fact">
          <dt className="memory-fact-head">
            详情
            <button type="button" className="btn btn-small" onClick={onAdd}>
              <Icon name="plus" size={14} />
              添加
            </button>
          </dt>
          <dd>
            <ul className="memory-details">
              {view.details.map((m) => (
                <DetailLine key={m.id} item={m} focus={focus === `item-${m.id}`} onFocused={onFocused} onOpen={() => onOpenItem(m.id)} />
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </>
  );
}

/** A detail on its entry's page: a bullet, the whole sentence; it opens the detail's page. */
function DetailLine({ item, focus, onFocused, onOpen }: { item: MemoryItem; focus: boolean; onFocused(): void; onOpen(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    onFocused();
  }, [focus, onFocused]);
  return (
    <li>
      <button ref={ref} type="button" className="text-btn memory-detail-line" onClick={onOpen}>
        {item.text}
      </button>
    </li>
  );
}

/** A detail's page: the whole sentence with 编辑 and 删除 at the right (or the box editing it), then the facts. */
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
  onSave(text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  onDelete(): void;
}) {
  return (
    <>
      {editing ? (
        <DetailForm initial={item.text} onCancel={() => onEdit(false)} onSave={onSave} />
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

/** Saving a form: the result, or the problem in words. */
function useSave(onDone: () => void) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (go: () => Promise<MemoryCardMeta | MemoryRefusal | undefined>) => {
    if (busy) return;
    setBusy(true);
    void go().then((r) => {
      setBusy(false);
      const no = refusal(r);
      if (no) setProblem(no);
      else if (r) onDone();
    });
  };
  return { problem, setProblem, busy, run };
}

/** The box adding (initial '') or editing a detail, then 取消 and 保存. Esc cancels it (a layer). */
function DetailForm({ initial, onCancel, onSave }: { initial: string; onCancel(): void; onSave(text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined> }) {
  const [text, setText] = useState(initial);
  const { problem, setProblem, busy, run } = useSave(onCancel);
  const value = text.trim();
  const tooLong = value.length > MEMORY_CHARS;
  const ok = !!value && !tooLong && value !== initial && !busy;
  const save = () => {
    if (ok) run(() => onSave(value));
  };
  // A layer of Esc: cancels the edit (or the adding), and only that (the settings stay open).
  useEscape(true, onCancel);
  const shown = tooLong ? REFUSED.too_long : problem;
  return (
    <div className="memory-edit">
      <textarea
        className="input textarea memory-input"
        aria-label="详情"
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
      <FormActions ok={ok} onCancel={onCancel} onSave={save} />
    </div>
  );
}

/**
 * The boxes making an entry (名字, 摘要, 类别 and its first 详情) or editing one (名字, 摘要, 类别), then 取消 and 保存.
 * Esc cancels it (a layer).
 */
function EntryForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: MemoryEntry;
  onCancel(): void;
  onSave(input: MemoryEntryInput, text?: string): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [category, setCategory] = useState<MemoryCategory | undefined>(initial?.category);
  const [text, setText] = useState('');
  const { problem, setProblem, busy, run } = useSave(onCancel);
  const v = { name: name.trim(), summary: summary.trim(), text: text.trim() };
  const tooLong = v.name.length > NAME_CHARS ? FIELD_REFUSED.name.too_long : v.summary.length > SUMMARY_CHARS ? FIELD_REFUSED.summary.too_long : v.text.length > MEMORY_CHARS ? REFUSED.too_long : null;
  const unchanged = !!initial && v.name === initial.name && v.summary === initial.summary && category === initial.category;
  const ok = !!v.name && !!v.summary && (!!initial || !!v.text) && !tooLong && !unchanged && !busy;
  const save = () => {
    if (ok) run(() => onSave({ name: v.name, summary: v.summary, ...(category ? { category } : {}) }, initial ? undefined : v.text));
  };
  useEscape(true, onCancel);
  const shown = tooLong ?? problem;
  const edit = (set: (s: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setProblem(null);
  };
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div className="memory-edit memory-entry-form">
      <label className="memory-field">
        <span className="memory-pick-label">名字</span>
        <input className="input" aria-label="名字" value={name} autoFocus spellCheck={false} onChange={edit(setName)} onKeyDown={enter} />
      </label>
      <label className="memory-field">
        <span className="memory-pick-label">摘要</span>
        <input className="input" aria-label="摘要" value={summary} spellCheck={false} onChange={edit(setSummary)} onKeyDown={enter} />
      </label>
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
      {initial ? null : (
        <label className="memory-field">
          <span className="memory-pick-label">详情</span>
          <textarea className="input textarea memory-input" aria-label="详情" rows={3} value={text} spellCheck={false} onChange={edit(setText)} onKeyDown={enter} />
        </label>
      )}
      {shown ? <span className="field-error" role="alert">{shown}</span> : null}
      <FormActions ok={ok} onCancel={onCancel} onSave={save} />
    </div>
  );
}

function FormActions({ ok, onCancel, onSave }: { ok: boolean; onCancel(): void; onSave(): void }) {
  return (
    <div className="memory-edit-actions">
      <button type="button" className="btn btn-small" onClick={onCancel}>
        取消
      </button>
      <button type="button" className="btn btn-small btn-primary" disabled={!ok} onClick={onSave}>
        保存
      </button>
    </div>
  );
}
