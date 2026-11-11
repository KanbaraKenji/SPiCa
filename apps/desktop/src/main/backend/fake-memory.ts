// The demo backend's memory: the same rules as the core's MemoryBook (items are
// never deleted, a replacement and an undo can be taken back), kept in memory.
// Also how the demo decides what a message asks it to remember, so a demo
// conversation shows the 已记住 / 已更新 / 已忘记 line.
import type { CoreEventBody, MemoryCardMeta, MemoryItem, MemoryRefusal } from '@spica/protocol';

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

export class FakeMemory {
  #items: MemoryItem[] = [];
  #next = 1;
  enabled = true;
  readonly #now: () => string;
  readonly #emit: (sessionId: string, body: CoreEventBody) => void;

  constructor(now: () => string, emit: (sessionId: string, body: CoreEventBody) => void) {
    this.#now = now;
    this.#emit = emit;
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
  add(o: { text: string; quote: string; by: 'assistant' | 'user'; replaces?: number; sessionId?: string; seq?: number }): MemoryCardMeta {
    const now = this.#now();
    const prev = o.replaces !== undefined ? this.#get(o.replaces) : undefined;
    const item = this.#put({
      id: this.#next++,
      owner: 'user',
      text: o.text,
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

  addOwn(text: string): MemoryCardMeta | MemoryRefusal {
    const t = text.trim();
    return this.#refusal(t) ?? this.#changed(this.add({ text: t, quote: t, by: 'user' }));
  }

  edit(id: number, text: string): MemoryCardMeta | MemoryRefusal | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const t = text.trim();
    return this.#refusal(t) ?? this.#changed({ action: 'edited', item: this.#put({ ...it, text: t, by: 'user', updatedAt: this.#now() }) });
  }

  /** `quiet`: the conversation sends the card itself (with its call id). */
  forget(id: number, by: 'assistant' | 'user', quiet = false): MemoryCardMeta | undefined {
    const it = this.#get(id);
    if (!it || it.status !== 'active') return undefined;
    const card: MemoryCardMeta = { action: 'forgotten', item: this.#put({ ...it, status: 'forgotten', by, updatedAt: this.#now() }) };
    return quiet ? card : this.#changed(card);
  }

  clear(): number {
    const now = this.#now();
    const active = this.#items.filter((m) => m.status === 'active');
    for (const m of active) this.#put({ ...m, status: 'forgotten', by: 'user', updatedAt: now });
    this.#changed({ action: 'cleared', count: active.length });
    return active.length;
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
    if (!this.enabled) return undefined;
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
