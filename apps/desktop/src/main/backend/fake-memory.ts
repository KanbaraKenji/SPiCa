// The demo backend's memory: the same rules as the core's MemoryBook (a
// replacement and an undo can be taken back; deleting in the settings is for
// good, with the older versions), kept in memory.
// Also how the demo decides what a message asks it to remember, so a demo
// conversation shows the 已记住 / 已更新 / 已忘记 line.
import type { CoreEventBody, MemoryCardMeta, MemoryCategory, MemoryItem, MemoryRefusal, MemoryTidyChange, MemoryTidyRun } from '@spica/protocol';

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

/** The demo's notes (the 演示 data): every category, one with three, and two from before there were categories. */
export const DEMO_MEMORIES: { text: string; category?: MemoryCategory; daysAgo: number }[] = [
  { text: '回答先给结论，再说细节', category: 'you', daysAgo: 12 },
  { text: '在工程部负责样品和报价', category: 'you', daysAgo: 30 },
  { text: '报价单金额一律写含税价', category: 'areas', daysAgo: 9 },
  { text: '周报每周一上午发', category: 'areas', daysAgo: 4 },
  { text: '客户名称写全称，不用简称', category: 'areas', daysAgo: 20 },
  { text: '关注注塑模具的材料和交期', category: 'topics', daysAgo: 15 },
  { text: '王经理是直属上司，周报发给他', category: 'people', daysAgo: 4 },
  { text: '出差报销找李老师审批', category: 'people', daysAgo: 25 },
  { text: '外壳样机项目：月底前交第二版样机', category: 'projects', daysAgo: 6 },
  { text: '写给客户的邮件开头不用客套话', daysAgo: 60 },
  { text: '一般周三下午不开会', daysAgo: 45 },
];

const ITEM_CHARS = 200;
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
    for (const s of seed) {
      const at = new Date(today - s.daysAgo * 86_400_000).toISOString();
      this.#put({ id: this.#next++, owner: 'user', text: s.text, quote: s.text, status: 'active', ...(s.category ? { category: s.category } : {}), by: 'user', createdAt: at, updatedAt: at });
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
      .find(([a, b]) => overlap(a.text, b.text) >= 0.3 && !unmerged.some((u) => u.includes(a.id) && u.includes(b.id)));
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
      changes.push({ action: 'added', item: this.#put({ id: this.#next++, owner: 'user', text, category: guessCategory(text), quote: m.text, status: 'active', sessionId: m.sessionId, seq: m.seq, by: 'assistant', tidyId: id, createdAt: now, updatedAt: now }) });
    }
    // notes from before there were categories get one (not a change: nothing to undo, the date stays)
    let categorized = 0;
    for (const m of this.list()) {
      if (m.category) continue;
      this.#put({ ...m, category: guessCategory(m.text) });
      categorized++;
    }
    const until = fresh.at(-1)?.at;
    if (until) this.#cursor = until;
    const run: MemoryTidyRun = { id, by: 'user', status: 'done', startedAt: now, endedAt: now, sessions: new Set(fresh.map((m) => m.sessionId)).size, messages: fresh.length, changes, refused: 0, costUsd: 0.0004, ...(categorized ? { categorized } : {}), ...(until ? { until } : {}) };
    this.#runs.unshift(run);
    if (changes.length || categorized) this.#changed({ action: 'tidied', count: changes.length });
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
    if (any) this.#changed({ action: 'undone' });
    return structuredClone(run);
  }

  list(opts: { all?: boolean } = {}): MemoryItem[] {
    return structuredClone(this.#items.filter((m) => opts.all || m.status === 'active'));
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

  /** remember (from a conversation: `callId`) or an item the user adds in the settings. */
  add(o: { text: string; quote: string; by: 'assistant' | 'user'; category?: MemoryCategory; replaces?: number; sessionId?: string; seq?: number }): MemoryCardMeta {
    const now = this.#now();
    const prev = o.replaces !== undefined ? this.#get(o.replaces) : undefined;
    const category = o.category ?? prev?.category;
    const item = this.#put({
      id: this.#next++,
      owner: 'user',
      text: o.text,
      ...(category ? { category } : {}),
      quote: o.quote,
      status: 'active',
      ...(prev ? { replaces: prev.id } : {}),
      ...(o.sessionId ? { sessionId: o.sessionId } : {}),
      ...(o.seq !== undefined ? { seq: o.seq } : {}),
      by: o.by,
      createdAt: now,
      updatedAt: now,
    });
    if (!prev) return { action: 'saved', item };
    return { action: 'replaced', item, previous: this.#put({ ...prev, status: 'replaced', replacedBy: item.id, updatedAt: now }) };
  }

  addOwn(text: string, category?: MemoryCategory): MemoryCardMeta | MemoryRefusal {
    const t = text.trim();
    return this.#refusal(t) ?? this.#changed(this.add({ text: t, quote: t, by: 'user', ...(category ? { category } : {}) }));
  }

  edit(id: number, text: string, category?: MemoryCategory): MemoryCardMeta | MemoryRefusal | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const t = text.trim();
    return this.#refusal(t) ?? this.#changed({ action: 'edited', item: this.#put({ ...it, text: t, ...(category ? { category } : {}), by: 'user', updatedAt: this.#now() }) });
  }

  /** `quiet`: the conversation sends the card itself (with its call id). */
  forget(id: number, by: 'assistant' | 'user', quiet = false): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const card: MemoryCardMeta = { action: 'forgotten', item: this.#put({ ...it, status: 'forgotten', by, updatedAt: this.#now() }) };
    return quiet ? card : this.#changed(card);
  }

  /** Settings 删除: the item goes for good, with the replaced items behind it. */
  delete(id: number): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    this.#drop(it.id);
    return this.#changed({ action: 'deleted', item: structuredClone(it) });
  }

  /** Settings 全部清除: every active item goes for good, as with delete. */
  clear(): number {
    const active = this.#items.filter((m) => m.status === 'active');
    for (const m of active) this.#drop(m.id);
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
