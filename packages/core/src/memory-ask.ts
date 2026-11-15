// Changing one entry with a sentence the user types at the foot of its page in
// the settings (as on Claude's memory page): the default model reads that entry
// (its name, category, summary and every detail with its number), the names and
// summaries of the other entries (to move a detail to one), and the sentence; it
// answers with the changes to make and a word back. The model only proposes;
// every change is checked here against the store as it is when the answer comes,
// and dropped when it fails:
// - a detail's number is one of this entry's (on a note in no entry: that note);
// - the name, summary and category changed are this entry's;
// - a move goes to another entry there is, or to a new one with a summary;
// - the same rules as remember for a note, a name and a summary, the user's
//   sentence being the words they rest on; a rewrite keeps the old detail's
//   numbers and people unless the sentence changes them;
// - a name another entry has is refused.
// What passes is applied as a tidy (memory-tidy.ts: apply, applyArrange), so it
// is recorded the same way (by 'ask') and undone the same way. The entry's
// summary has to stay true: when a detail was rewritten, forgotten or moved out
// and no new summary came with it, the entry is marked 待整理; an entry there
// was that a detail moved into is always marked (the model did not see its
// details, so it cannot write its summary).
import type { Runtime } from './runtime.ts';
import type { MemoryCategory, MemoryEntry, MemoryItem } from './types.ts';
import { MEMORY_CATEGORIES } from '@spica/protocol';
import type { Arrange, EntryPlan, Plan } from './memory-tidy.ts';
import { lostDetails, parseChanges } from './memory-tidy.ts';
import { CATEGORY_HINTS, categoryOf, entryProblem, MEMORY_LIMITS, noteProblem, sameName, USER_OWNER } from './memory.ts';

export const ASK_LIMITS = {
  /** The sentence typed, at most. */
  textChars: 500,
  /** The answer's room, and the word back shown at most. */
  maxTokens: 2_000,
  replyChars: 300,
};

/** The entry (or the note in no entry) whose page the sentence was typed on. */
export type AskTarget = { entry: number } | { item: number };

/** Built when used (memory.ts and this module import each other). */
export const askSystem = () =>
  [
    'You change one entry of the notes an assistant keeps about its user (its memory), as the user asks in one sentence typed on that entry\'s page.',
    'An entry is about one thing: a name, a category, a one-line summary, and its notes (details), each with a number [n].',
    'You get the entry, the names and summaries of the other entries, and the sentence. Do only what the sentence asks, to this entry:',
    '- summarized: give the new summary.',
    '- renamed: give the new name.',
    `- categorized: give the new category (${MEMORY_CATEGORIES.map((c) => `${c} = ${CATEGORY_HINTS[c]}`).join('; ')}).`,
    '- added: give a new detail.',
    '- rewritten: give the number of a detail and its new words.',
    '- forgotten: give the number of a detail to take out.',
    '- moved: give the number of a detail and the entry it goes to: the name of another entry listed, or a new name with its summary and category.',
    'When a detail is rewritten, forgotten or moved out and the summary says what it held, also give summarized with the summary of what is left.',
    `A detail has no subject (喜欢简短回答，先给结论, not 用户喜欢…), is in the user's language, at most ${MEMORY_LIMITS.itemChars} characters. A name is short (at most ${MEMORY_LIMITS.nameChars} characters), a summary one line (at most ${MEMORY_LIMITS.summaryChars}) without a subject.`,
    'Also give reply: one short sentence to the user in their language, saying what you did, or, when the sentence asks for something you cannot do here (about another entry, not about this memory) or you do not understand it, why, with no changes.',
    'Answer with JSON only: {"changes":[{"action":"summarized","summary":"…"},{"action":"renamed","name":"…"},{"action":"categorized","category":"people"},{"action":"added","text":"…"},{"action":"rewritten","id":3,"text":"…"},{"action":"forgotten","id":4},{"action":"moved","id":5,"entry":"周报"},{"action":"moved","id":6,"entry":"新名字","summary":"…","category":"areas"}],"reply":"…"}',
  ].join('\n');

/** What the model reads: the entry (or the note), the other entries, the sentence; undefined when it is gone. */
export function askPrompt(rt: Runtime, target: AskTarget, text: string, owner = USER_OWNER): string | undefined {
  const scope = scopeOf(rt, target, owner);
  if (!scope) return undefined;
  const line = (m: MemoryItem) => `[${m.id}] ${m.text}`;
  const others = scope.others.map((e) => `- ${e.name} (${e.category ?? 'no category'}): ${e.summary}`);
  return [
    ...(scope.entry
      ? [`The entry: ${scope.entry.name} (${scope.entry.category ?? 'no category'})`, `Summary: ${scope.entry.summary}`, 'Details:', ...scope.details.map(line)]
      : ['A note in no entry yet (moved: put it into an entry):', ...scope.details.map(line)]),
    '',
    'Other entries:',
    ...(others.length ? others : ['(none)']),
    '',
    `The user's sentence: ${text}`,
  ].join('\n');
}

/** The entry asked about (none for a note in no entry), its active details (or that note), and the other entries with details. */
function scopeOf(rt: Runtime, target: AskTarget, owner: string): { entry?: MemoryEntry; details: MemoryItem[]; others: MemoryEntry[] } | undefined {
  const active = rt.store.listMemories(owner).filter((m) => m.status === 'active');
  const entries = rt.store.listMemoryEntries(owner);
  const live = (e: MemoryEntry) => active.some((m) => m.entryId === e.id);
  if ('entry' in target) {
    const entry = entries.find((e) => e.id === target.entry);
    const details = active.filter((m) => m.entryId === target.entry);
    if (!entry || details.length === 0) return undefined;
    return { entry, details, others: entries.filter((e) => e.id !== entry.id && live(e)) };
  }
  const it = active.find((m) => m.id === target.item);
  if (!it || (it.entryId !== undefined && entries.some((e) => e.id === it.entryId))) return undefined;
  return { details: [it], others: entries.filter(live) };
}

/** The changes and the word back in the model's answer; an answer that is no JSON is all word back. */
export function parseAsk(text: string): { changes: Record<string, unknown>[]; reply?: string } {
  const changes = parseChanges(text);
  let reply: string | undefined;
  const start = text.indexOf('{');
  try {
    const v = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as { reply?: unknown };
    if (typeof v.reply === 'string') reply = v.reply;
  } catch {
    // cut short or no JSON: below
  }
  if (reply === undefined && !changes) reply = text;
  const said = reply?.trim().slice(0, ASK_LIMITS.replyChars);
  return { changes: changes ?? [], ...(said ? { reply: said } : {}) };
}

/**
 * The proposed changes that pass the checks (see the top of this file), how many did not, and the entries to mark
 * 待整理 once they are applied.
 */
export function checkAsk(
  rt: Runtime,
  target: AskTarget,
  proposed: Record<string, unknown>[],
  said: string,
  owner = USER_OWNER,
): { plans: Plan[]; arrange: Arrange; refused: number; stale: number[] } {
  const plans: Plan[] = [];
  const arrange: Arrange = { group: [], summarize: [], confirm: [] };
  const stale = new Set<number>();
  let refused = 0;
  const scope = scopeOf(rt, target, owner);
  if (!scope) return { plans, arrange, refused: proposed.length, stale: [] };
  const secrets = (t: string) => rt.redact(t);
  const mine = new Map(scope.details.map((m) => [m.id, m]));
  const touched = new Set<number>();
  const entry = scope.entry;
  const edit: { summary?: string; name?: string; category?: MemoryCategory } = {};
  let detailsChanged = false;
  // new entries named by moves: the first with a name makes it, later ones go into it
  const made: { name: string; summary: string; category?: MemoryCategory }[] = [];
  const moves = new Map<string, { items: MemoryItem[]; entry: EntryPlan }>();
  const taken = (name: string) => scope.others.some((e) => sameName(e.name, name));
  const no = () => {
    refused++;
  };
  /** The detail `c` names when it is this entry's (or this note) and not touched yet. */
  const detail = (c: Record<string, unknown>) => {
    const m = mine.get(Number(c.id));
    return m && !touched.has(m.id) ? m : undefined;
  };
  for (const c of proposed) {
    const action = String(c.action ?? '');
    const text = String(c.text ?? '').trim();
    if (action === 'summarized' || action === 'renamed' || action === 'categorized') {
      if (!entry) {
        no();
        continue;
      }
      if (action === 'summarized') {
        const summary = String(c.summary ?? '').trim();
        if (summary === entry.summary) {
          // given back as it is: right as it stands
          if (entry.stale && !arrange.confirm.some((e) => e.id === entry.id)) arrange.confirm.push(entry);
          continue;
        }
        if (edit.summary !== undefined || entryProblem({ name: edit.name ?? entry.name, summary }, said, secrets)) no();
        else edit.summary = summary;
      } else if (action === 'renamed') {
        const name = String(c.name ?? '').trim();
        if (sameName(name, entry.name) && name === entry.name) continue;
        if (edit.name !== undefined || taken(name) || made.some((m) => sameName(m.name, name)) || entryProblem({ name, summary: edit.summary ?? entry.summary }, said, secrets)) no();
        else edit.name = name;
      } else {
        const category = categoryOf(c.category);
        if (!category || category === entry.category) {
          if (!category) no();
          continue;
        }
        edit.category = category;
      }
      continue;
    }
    if (action === 'added') {
      if (noteProblem(text, said, secrets) || scope.details.some((m) => m.text === text)) {
        no();
        continue;
      }
      plans.push({ action: 'added', text, quote: said, from: {}, ...(entry ? { entry: { id: entry.id } } : {}) });
      continue;
    }
    const m = detail(c);
    if (!m) {
      no();
      continue;
    }
    if (action === 'rewritten') {
      if (text === m.text || noteProblem(text, said, secrets) || lostDetails(m.text, text, said).length) {
        no();
        continue;
      }
      touched.add(m.id);
      detailsChanged = true;
      plans.push({ action: 'rewritten', prev: m, text, quote: said, from: {} });
    } else if (action === 'forgotten') {
      touched.add(m.id);
      detailsChanged = true;
      plans.push({ action: 'forgotten', prev: m, quote: said, from: {} });
    } else if (action === 'moved') {
      const name = String(c.entry ?? '').trim();
      const there = scope.others.find((e) => sameName(e.name, name));
      let to: EntryPlan | undefined;
      if (there) to = { id: there.id };
      else if (name && !(entry && sameName(entry.name, name))) {
        const earlier = made.find((x) => sameName(x.name, name));
        if (earlier) to = earlier;
        else {
          const summary = String(c.summary ?? '').trim();
          const category = categoryOf(c.category);
          if (!entryProblem({ name, summary }, said, secrets)) {
            to = { name, summary, ...(category ? { category } : {}) };
            made.push(to);
          }
        }
      }
      if (!to) {
        no();
        continue;
      }
      touched.add(m.id);
      detailsChanged = true;
      const key = 'id' in to ? `#${to.id}` : to.name;
      const g = moves.get(key) ?? { items: [], entry: to };
      g.items.push(m);
      moves.set(key, g);
      if ('id' in to) stale.add(to.id);
    } else no();
  }
  arrange.group.push(...moves.values());
  if (entry && (edit.summary !== undefined || edit.name !== undefined || edit.category !== undefined)) arrange.summarize.push({ entry, ...edit });
  // this entry's details changed without a new summary: it may still say what went
  if (entry && detailsChanged && edit.summary === undefined) stale.add(entry.id);
  return { plans, arrange, refused, stale: [...stale] };
}
