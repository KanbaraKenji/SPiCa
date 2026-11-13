// The demo backend's memory: the same rules as the core's MemoryBook (entries
// with a name, a summary and a category, whose details are the items; a
// replacement and an undo can be taken back; deleting in the settings is for
// good, with the older versions), kept in memory.
// Also how the demo decides what a message asks it to remember, so a demo
// conversation shows the 已记住 / 已更新 / 已忘记 line.
import type { CoreEventBody, MemoryCardMeta, MemoryCategory, MemoryEntry, MemoryEntryInput, MemoryItem, MemoryRefusal, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';

/**
 * The demo's guess at a note's category (the core asks the model): people named with a title, a project's words,
 * how the user wants answers, the duties of their work; anything else is a topic.
 */
export function guessCategory(text: string): MemoryCategory {
  if (/[一-龥](经理|总监|主管|老师|老板)|同事/.test(text)) return 'people';
  if (/项目|样机|评审|立项|上线/.test(text)) return 'projects';
  if (/回答|结论|习惯|喜欢|称呼|我是|我负责|一般/.test(text)) return 'you';
  if (/报价|周报|报销|合同|客户|发票|邮件/.test(text)) return 'areas';
  return 'topics';
}

/**
 * The demo's entry for a note (the core asks the model): one of the demo's names by its words, else a new one named
 * after its first words.
 */
export function guessEntry(text: string): MemoryEntryInput {
  const category = guessCategory(text);
  const named = ([
    [/王经理/, '王经理'],
    [/李老师/, '李老师'],
    [/样机/, '外壳样机'],
    [/回答|结论/, '回答习惯'],
    [/周报/, '周报'],
    [/报价|客户名称|样品/, '工程部职责'],
    [/邮件/, '客户邮件'],
    [/开会|周[一二三四五]|下午|上午/, '作息'],
    [/模具/, '注塑模具'],
  ] as const).find(([re]) => re.test(text))?.[1];
  const name = named ?? text.replace(/[，,。.：:].*$/, '').slice(0, 8);
  return { name, summary: text.slice(0, 60), category };
}

/** The demo's memory (the 演示 data): every category, one entry with three details, and two notes from before there were entries. */
export const DEMO_MEMORIES: { entry?: MemoryEntryInput; details: { text: string; daysAgo: number }[] }[] = [
  {
    entry: { name: '回答习惯', summary: '先给结论，再说细节；回答尽量简短', category: 'you' },
    details: [
      { text: '回答先给结论，再说细节', daysAgo: 12 },
      { text: '回答尽量简短', daysAgo: 8 },
    ],
  },
  {
    entry: { name: '工程部职责', summary: '负责样品和报价；报价单写含税价，客户名称写全称', category: 'areas' },
    details: [
      { text: '在工程部负责样品和报价', daysAgo: 30 },
      { text: '报价单金额一律写含税价', daysAgo: 9 },
      { text: '客户名称写全称，不用简称', daysAgo: 20 },
    ],
  },
  { entry: { name: '周报', summary: '每周一上午发给王经理', category: 'areas' }, details: [{ text: '周报每周一上午发', daysAgo: 4 }] },
  { entry: { name: '注塑模具', summary: '关注模具的材料和交期', category: 'topics' }, details: [{ text: '关注注塑模具的材料和交期', daysAgo: 15 }] },
  {
    entry: { name: '王经理', summary: '直属上司，周报发给他', category: 'people' },
    details: [
      { text: '王经理是直属上司', daysAgo: 40 },
      { text: '周报发给王经理', daysAgo: 4 },
    ],
  },
  { entry: { name: '李老师', summary: '出差报销找他审批', category: 'people' }, details: [{ text: '出差报销找李老师审批', daysAgo: 25 }] },
  { entry: { name: '外壳样机', summary: '月底前交第二版样机', category: 'projects' }, details: [{ text: '外壳样机项目：月底前交第二版样机', daysAgo: 6 }] },
  {
    details: [
      { text: '写给客户的邮件开头不用客套话', daysAgo: 60 },
      { text: '一般周三下午不开会', daysAgo: 45 },
    ],
  },
];

const ITEM_CHARS = 200;
const NAME_CHARS = 30;
const SUMMARY_CHARS = 120;
const SECRET = /(密码|口令|密钥|验证码|password|api\s*key|secret)\s*(是|为|:|：|=|is)\s*\S|(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)|\b\d{17}[\dXx]\b/i;

/** Lower case, width-folded, without spaces and punctuation (how sentences are compared). */
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Share of the character pairs of `a` also found in `b`. */
function overlap(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < 2) return 0;
  const pairs = new Set<string>();
  for (let i = 0; i < y.length - 1; i++) pairs.add(y.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < x.length - 1; i++) if (pairs.has(x.slice(i, i + 2))) hit++;
  return hit / (x.length - 1);
}

/** What a demo message asks of the memory (undefined: nothing). */
export type MemoryPlan = { action: 'save'; text: string } | { action: 'replace'; text: string; replaces: number } | { action: 'forget'; id: number };

/** A message the user typed, as the demo's tidy reads it. */
export interface TypedMessage {
  sessionId: string;
  seq: number;
  at: string;
  text: string;
}

export class FakeMemory {
  #items: MemoryItem[] = [];
  #next = 1;
  #entries: MemoryEntry[] = [];
  #nextEntry = 1;
  #runs: MemoryTidyRun[] = [];
  /** The messages ("sessionId#seq") of items deleted for good: a tidy does not note them again. */
  readonly #deletedFrom = new Set<string>();
  #cursor: string | undefined;
  #enabled = true;
  readonly #now: () => string;
  readonly #emit: (sessionId: string, body: CoreEventBody) => void;

  constructor(now: () => string, emit: (sessionId: string, body: CoreEventBody) => void, seed: readonly (typeof DEMO_MEMORIES)[number][] = []) {
    this.#now = now;
    this.#emit = emit;
    const today = Date.parse(now());
    const ago = (days: number) => new Date(today - days * 86_400_000).toISOString();
    for (const s of seed) {
      const first = ago(Math.max(...s.details.map((d) => d.daysAgo)));
      const entry = s.entry ? this.#putEntry({ id: this.#nextEntry++, owner: 'user', ...s.entry, by: 'user', createdAt: first, updatedAt: first }) : undefined;
      for (const d of s.details) {
        const at = ago(d.daysAgo);
        this.#put({ id: this.#next++, owner: 'user', text: d.text, quote: d.text, status: 'active', ...(entry ? { entryId: entry.id } : {}), by: 'user', createdAt: at, updatedAt: at });
      }
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(on: boolean) {
    if (on && !this.#enabled) this.#cursor = this.#now();
    this.#enabled = on;
  }

  /**
   * The demo's tidy (the core asks the default model): notes that share most of their words are merged, and a
   * standing remark not yet noted (以后 / 习惯 / 一般 / 每周 …) is added. Applied as one group that can be undone.
   */
  tidy(messages: TypedMessage[]): MemoryTidyRun | { off: true } {
    if (!this.#enabled) return { off: true };
    const fresh = messages.filter((m) => !this.#cursor || m.at > this.#cursor).sort((a, b) => a.at.localeCompare(b.at));
    const id = (this.#runs[0]?.id ?? 0) + 1;
    const now = this.#now();
    const changes: MemoryTidyChange[] = [];
    const active = this.list();
    const unmerged = this.#runs.flatMap((r) => r.changes).filter((c) => c.action === 'merged' && c.undone).map((c) => (c.previous ?? []).map((p) => p.id));
    const pair = active
      .flatMap((a, i) => active.slice(i + 1).map((b) => [a, b] as const))
      .find(([a, b]) => a.entryId === b.entryId && overlap(a.text, b.text) >= 0.3 && !unmerged.some((u) => u.includes(a.id) && u.includes(b.id)));
    if (pair) {
      const [a, b] = pair;
      const short = a.text.length <= b.text.length ? a : b;
      const item = this.#put({ ...short, id: this.#next++, quote: `${a.quote} / ${b.quote}`, replaces: b.id, tidyId: id, createdAt: now, updatedAt: now });
      const previous = [a, b].map((m) => this.#put({ ...m, status: 'replaced', replacedBy: item.id, tidyId: id, updatedAt: now }));
      changes.push({ action: 'merged', item, previous });
    }
    for (const m of fresh) {
      if (changes.filter((c) => c.action === 'added').length >= 3) break;
      if (!/以后|习惯|一般|每周|总是/.test(m.text) || /记住|别记|忘掉/.test(m.text) || SECRET.test(m.text)) continue;
      if (this.#deletedFrom.has(`${m.sessionId}#${m.seq}`) || this.#items.some((x) => (x.sessionId === m.sessionId && x.seq === m.seq) || overlap(m.text, x.text) >= 0.5)) continue;
      const text = m.text.replace(/^(跟你说一下|对了)[，,：:\s]*/, '').replace(/^我/, '').slice(0, ITEM_CHARS);
      const entry = this.#entryFor(guessEntry(text), 'assistant', now);
      changes.push({ action: 'added', item: this.#put({ id: this.#next++, owner: 'user', text, entryId: entry.id, quote: m.text, status: 'active', sessionId: m.sessionId, seq: m.seq, by: 'assistant', tidyId: id, createdAt: now, updatedAt: now }), entry: entry.name });
    }
    // notes from before there were entries go into one (not a change: the note stays as it was; the whole tidy's undo takes it out)
    const grouped: NonNullable<MemoryTidyRun['grouped']> = [];
    for (const m of this.list()) {
      if (m.entryId !== undefined && this.#entry(m.entryId)) continue;
      const entry = this.#entryFor(guessEntry(m.text), 'assistant', now);
      this.#put({ ...m, entryId: entry.id });
      grouped.push({ item: m.id, entry: entry.id });
    }
    const until = fresh.at(-1)?.at;
    if (until) this.#cursor = until;
    const run: MemoryTidyRun = { id, by: 'user', status: 'done', startedAt: now, endedAt: now, sessions: new Set(fresh.map((m) => m.sessionId)).size, messages: fresh.length, changes, refused: 0, costUsd: 0.0004, ...(grouped.length ? { grouped } : {}), ...(until ? { until } : {}) };
    this.#runs.unshift(run);
    if (changes.length || grouped.length) this.#changed({ action: 'tidied', count: changes.length });
    return structuredClone(run);
  }

  tidies(limit = 5): MemoryTidyRun[] {
    return structuredClone(this.#runs.slice(0, limit));
  }

  /** 撤销 a tidy or one of its changes: only what still stands. */
  undoTidy(id: number, change?: number): MemoryTidyRun | undefined {
    const run = this.#runs.find((r) => r.id === id);
    if (!run) return undefined;
    const now = this.#now();
    let any = false;
    for (const i of change === undefined ? run.changes.map((_, n) => n).reverse() : [change]) {
      const c = run.changes[i];
      const cur = c && this.#get(c.item.id);
      if (!c || c.undone || !cur || cur.status !== 'active') continue;
      this.#put({ ...cur, status: 'forgotten', undone: true, by: 'user', updatedAt: now });
      for (const p of c.previous ?? []) {
        const old = this.#get(p.id);
        if (!old || old.status !== 'replaced' || old.replacedBy !== cur.id) continue;
        const { replacedBy: _r, ...rest } = old;
        void _r;
        this.#put({ ...rest, status: 'active', updatedAt: now });
      }
      c.undone = true;
      any = true;
    }
    // the whole tidy: the notes it put into entries are in none again
    if (change === undefined) {
      for (const g of run.grouped ?? []) {
        const cur = this.#get(g.item);
        if (!cur || cur.status !== 'active' || cur.entryId !== g.entry) continue;
        const { entryId: _e, ...rest } = cur;
        void _e;
        this.#put(rest);
        any = true;
      }
    }
    if (any) this.#changed({ action: 'undone' });
    return structuredClone(run);
  }

  list(opts: { all?: boolean } = {}): MemoryItem[] {
    return structuredClone(this.#items.filter((m) => opts.all || m.status === 'active'));
  }

  /** The entries with an active detail. */
  entries(): MemoryEntry[] {
    const live = new Set(this.#items.filter((m) => m.status === 'active').map((m) => m.entryId));
    return structuredClone(this.#entries.filter((e) => live.has(e.id)));
  }

  #entry(id: number): MemoryEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  #named(name: string): MemoryEntry | undefined {
    return this.#entries.find((e) => normalize(e.name) === normalize(name));
  }

  #putEntry(e: MemoryEntry): MemoryEntry {
    const at = this.#entries.findIndex((x) => x.id === e.id);
    if (at >= 0) this.#entries[at] = e;
    else this.#entries.push(e);
    return structuredClone(e);
  }

  /** The entry with this name, or a new one. */
  #entryFor(input: MemoryEntryInput, by: 'assistant' | 'user', now: string): MemoryEntry {
    return this.#named(input.name) ?? this.#putEntry({ id: this.#nextEntry++, owner: 'user', name: input.name, summary: input.summary, ...(input.category ? { category: input.category } : {}), by, createdAt: now, updatedAt: now });
  }

  #get(id: number): MemoryItem | undefined {
    return this.#items.find((m) => m.id === id);
  }

  #put(m: MemoryItem): MemoryItem {
    const at = this.#items.findIndex((x) => x.id === m.id);
    if (at >= 0) this.#items[at] = m;
    else this.#items.push(m);
    return structuredClone(m);
  }

  /** A change the user made in the settings (or an undo): sent on no conversation. */
  #changed(card: MemoryCardMeta): MemoryCardMeta {
    this.#emit('', { type: 'memory.changed', card });
    return card;
  }

  #refusal(t: string): MemoryRefusal | undefined {
    if (!t) return { refused: 'empty' };
    if (t.length > ITEM_CHARS) return { refused: 'too_long' };
    if (SECRET.test(t)) return { refused: 'secret' };
    return undefined;
  }

  #entryRefusal(e: MemoryEntryInput, self?: number): MemoryRefusal | undefined {
    const name = e.name.trim();
    const summary = e.summary.trim();
    if (!name) return { refused: 'empty', field: 'name' };
    if (name.length > NAME_CHARS) return { refused: 'too_long', field: 'name' };
    if (SECRET.test(name)) return { refused: 'secret', field: 'name' };
    const taken = this.#named(name);
    if (taken && taken.id !== self && this.#items.some((m) => m.entryId === taken.id && m.status === 'active')) return { refused: 'name_taken', field: 'name' };
    if (!summary) return { refused: 'empty', field: 'summary' };
    if (summary.length > SUMMARY_CHARS) return { refused: 'too_long', field: 'summary' };
    if (SECRET.test(summary)) return { refused: 'secret', field: 'summary' };
    return undefined;
  }

  /** remember (from a conversation: `callId`) or an item the user adds in the settings; in `entry` (by name: the one there is or a new one), or the replaced item's. */
  add(o: { text: string; quote: string; by: 'assistant' | 'user'; entry?: number | MemoryEntryInput; replaces?: number; sessionId?: string; seq?: number }): MemoryCardMeta {
    const now = this.#now();
    const prev = o.replaces !== undefined ? this.#get(o.replaces) : undefined;
    const ref = o.entry ?? prev?.entryId;
    const entry = ref === undefined ? undefined : typeof ref === 'number' ? this.#entry(ref) : this.#entryFor(ref, o.by, now);
    const item = this.#put({
      id: this.#next++,
      owner: 'user',
      text: o.text,
      ...(entry ? { entryId: entry.id } : {}),
      quote: o.quote,
      status: 'active',
      ...(prev ? { replaces: prev.id } : {}),
      ...(o.sessionId ? { sessionId: o.sessionId } : {}),
      ...(o.seq !== undefined ? { seq: o.seq } : {}),
      by: o.by,
      createdAt: now,
      updatedAt: now,
    });
    const withEntry = entry ? { entry: structuredClone(entry) } : {};
    if (!prev) return { action: 'saved', item, ...withEntry };
    return { action: 'replaced', item, previous: this.#put({ ...prev, status: 'replaced', replacedBy: item.id, updatedAt: now }), ...withEntry };
  }

  addOwn(text: string, entry?: number | MemoryEntryInput): MemoryCardMeta | MemoryRefusal {
    const t = text.trim();
    const no = this.#refusal(t) ?? (entry === undefined || typeof entry === 'number' ? undefined : this.#entryRefusal(entry));
    if (no) return no;
    const hidden = entry !== undefined && typeof entry !== 'number' ? this.#named(entry.name) : undefined;
    if (hidden && typeof entry === 'object') {
      const { category: _c, ...rest } = hidden;
      void _c;
      this.#putEntry({ ...rest, summary: entry.summary.trim(), ...(entry.category ? { category: entry.category } : {}), by: 'user', updatedAt: this.#now() });
    }
    const ref = typeof entry === 'object' ? { name: entry.name.trim(), summary: entry.summary.trim(), ...(entry.category ? { category: entry.category } : {}) } : entry;
    return this.#changed(this.add({ text: t, quote: t, by: 'user', ...(ref !== undefined ? { entry: ref } : {}) }));
  }

  edit(id: number, text: string): MemoryCardMeta | MemoryRefusal | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const t = text.trim();
    return this.#refusal(t) ?? this.#changed({ action: 'edited', item: this.#put({ ...it, text: t, by: 'user', updatedAt: this.#now() }) });
  }

  editEntry(id: number, input: MemoryEntryInput): MemoryCardMeta | MemoryRefusal | undefined {
    const cur = this.#entry(id);
    if (!cur) return undefined;
    const no = this.#entryRefusal(input, id);
    if (no) return no;
    const { category: _c, ...rest } = cur;
    void _c;
    const entry = this.#putEntry({ ...rest, name: input.name.trim(), summary: input.summary.trim(), ...(input.category ? { category: input.category } : {}), by: 'user', updatedAt: this.#now() });
    return this.#changed({ action: 'entry_edited', entry });
  }

  /** Settings 删除 on an entry: it and all its details go for good. */
  deleteEntry(id: number): MemoryCardMeta | undefined {
    const entry = this.#entry(id);
    if (!entry) return undefined;
    for (const m of this.#items.filter((x) => x.entryId === id)) this.#drop(m.id);
    this.#entries = this.#entries.filter((e) => e.id !== id);
    return this.#changed({ action: 'entry_deleted', entry: structuredClone(entry) });
  }

  /** `quiet`: the conversation sends the card itself (with its call id). */
  forget(id: number, by: 'assistant' | 'user', quiet = false): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const card: MemoryCardMeta = { action: 'forgotten', item: this.#put({ ...it, status: 'forgotten', by, updatedAt: this.#now() }) };
    return quiet ? card : this.#changed(card);
  }

  /** Settings 删除: the item goes for good, with the replaced items behind it (and its entry when it was the last). */
  delete(id: number): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const entry = it.entryId !== undefined ? this.#entry(it.entryId) : undefined;
    this.#drop(it.id);
    if (entry && !this.#items.some((m) => m.entryId === entry.id && m.status === 'active')) this.#entries = this.#entries.filter((e) => e.id !== entry.id);
    return this.#changed({ action: 'deleted', item: structuredClone(it), ...(entry ? { entry: structuredClone(entry) } : {}) });
  }

  /** Settings 全部清除: every entry and active item go for good, as with delete. */
  clear(): number {
    const active = this.#items.filter((m) => m.status === 'active');
    for (const m of active) this.#drop(m.id);
    this.#entries = [];
    this.#changed({ action: 'cleared', count: active.length });
    return active.length;
  }

  #drop(id: number): void {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) for (const m of this.#items) if (m.status === 'replaced' && m.replacedBy === ids[i] && !ids.includes(m.id)) ids.push(m.id);
    for (const m of this.#items) if (ids.includes(m.id) && m.sessionId && m.seq !== undefined) this.#deletedFrom.add(`${m.sessionId}#${m.seq}`);
    this.#items = this.#items.filter((m) => !ids.includes(m.id));
  }

  /** Regenerate: takes back what the old answer's cards did, newest first, where nothing touched the item since. */
  revert(cards: MemoryCardMeta[]): void {
    const mine = new Set<number>(); // changed by this revert (a note the answer saved, then changed)
    for (const card of [...cards].reverse()) {
      const made = card.item;
      const cur = made && this.#get(made.id);
      if (!made || !cur || !['saved', 'replaced', 'forgotten'].includes(card.action)) continue;
      if (cur.status !== made.status || (cur.updatedAt !== made.updatedAt && !mine.has(made.id))) continue;
      const done = this.undo(made.id);
      if (done?.item) mine.add(done.item.id);
      if (done?.previous) mine.add(done.previous.id);
    }
  }

  undo(id: number): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it) return undefined;
    const now = this.#now();
    if (it.status === 'forgotten') {
      const { replacedBy: _r, undone: _u, ...rest } = it;
      void _r;
      void _u;
      return this.#changed({ action: 'restored', item: this.#put({ ...rest, status: 'active', by: 'user', updatedAt: now }) });
    }
    if (it.status !== 'active') return undefined;
    const item = this.#put({ ...it, status: 'forgotten', undone: true, by: 'user', updatedAt: now });
    const prev = it.replaces !== undefined ? this.#get(it.replaces) : undefined;
    let previous: MemoryItem | undefined;
    if (prev && prev.status === 'replaced' && prev.replacedBy === it.id) {
      const { replacedBy: _r, ...rest } = prev;
      void _r;
      previous = this.#put({ ...rest, status: 'active', updatedAt: now });
    }
    return this.#changed({ action: 'undone', item, ...(previous ? { previous } : {}) });
  }

  /** What a message in the demo asks: 「…别记了」 forgets the closest item, 「改用…」 replaces it, 「记住…」「以后…」 saves. */
  plan(message: string): MemoryPlan | undefined {
    if (!this.#enabled) return undefined;
    const t = message.trim();
    const closest = () =>
      this.list()
        .map((m) => ({ id: m.id, score: overlap(m.text, t) }))
        .sort((a, b) => b.score - a.score)[0];
    if (/别记了|忘掉|不用记/.test(t)) {
      const c = closest();
      return c && c.score > 0 ? { action: 'forget', id: c.id } : undefined;
    }
    if (!/记住|以后|改用/.test(t) || SECRET.test(t)) return undefined;
    const text = t
      .replace(/^(跟你说一下|对了)[，,：:\s]*/, '')
      .replace(/^(请|帮我)?(记住|记一下)[：:，,\s]*/, '')
      .slice(0, ITEM_CHARS);
    if (!text) return undefined;
    const c = closest();
    if (/改用/.test(t) && c && c.score > 0.15) return { action: 'replace', text, replaces: c.id };
    return { action: 'save', text };
  }
}
