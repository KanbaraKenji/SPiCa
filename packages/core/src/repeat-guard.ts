// Repeated calls: the same tool with the same input, giving the same result, again and again in a row.
// RuntimeOptions.defaults.repeatRemind (the n-th such call gets a note for the model after its result; it is not
// shown to the user) and repeatStop (the n-th such call is not run, the run stops and the user decides whether to
// go on). 0 or absent = off, so callers that set neither behave as before; the desktop app gives 3 and 8.
// What counts as a repeat is read from the conversation's own messages, back to the last one the user typed:
// - the user writing starts the count again;
// - another tool or other input in between ends the row (a write that succeeded in between is such a call);
// - a different result ends it too: a call whose result changes (waiting for a job, reading its progress) is not
//   stuck, so polling never counts;
// - each sub-agent is its own conversation, so its calls are counted apart.
import { REPEAT_REMINDER_MARK, REPEAT_STOP_MARK } from '@spica/protocol';
import type { Message } from './types.ts';

/** The tool and its input as one string (keys in order, so {a,b} and {b,a} are the same call). */
export function callKey(name: string, input: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return `${name}\u0000${JSON.stringify(norm(input ?? null))}`;
}

/** A result as compared: without the fetch-time line, the outside-content fence and a reminder added to it. */
export function comparableResult(content: string): string {
  let s = content;
  const at = s.indexOf(REPEAT_REMINDER_MARK);
  if (at >= 0) s = s.slice(0, at);
  s = s.trim().replace(/^\[fetched at [^\]]*\]\n?/, '');
  s = s.replace(/^<untrusted_data\b[^>]*>\n?/, '').replace(/\n?<\/untrusted_data>\s*$/, '');
  return s.replace(/^\[fetched at [^\]]*\]\n?/, '').trim();
}

/**
 * The calls just before this one that were the same call with one same result, in a row, back to the last message
 * the user typed. Calls in the message that holds this one (`messageId`) are not looked at (their results are not in
 * yet). `result` is the result they share (undefined when none).
 */
export function repeatsBefore(messages: readonly Message[], messageId: string, name: string, input: unknown): { count: number; result?: string } {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (m.kind === 'user' || m.kind === 'steer') && (m.meta?.author ?? 'user') === 'user') {
      start = i + 1;
      break;
    }
  }
  const results = new Map<string, string>();
  const calls: { id: string; key: string }[] = [];
  for (const m of messages.slice(start)) {
    if (m.id === messageId) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && m.role === 'assistant') calls.push({ id: b.id, key: callKey(b.name, b.input) });
      else if (b.type === 'tool_result') results.set(b.toolUseId, b.content);
    }
  }
  const key = callKey(name, input);
  let count = 0;
  let shared: string | undefined;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.key !== key) break;
    const raw = results.get(c.id);
    if (raw === undefined || raw.includes(REPEAT_STOP_MARK)) break;
    const r = comparableResult(raw);
    if (shared === undefined) shared = r;
    else if (r !== shared) break;
    count++;
  }
  return shared === undefined ? { count } : { count, result: shared };
}

/** RuntimeOptions.defaults.repeatRemind / repeatStop as whole numbers; 0 = off. */
export function repeatLimits(defaults: { repeatRemind?: number; repeatStop?: number }): { remind: number; stop: number } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 2 ? Math.floor(v) : 0);
  return { remind: n(defaults.repeatRemind), stop: n(defaults.repeatStop) };
}

/** Added after the result of the n-th same call (for the model only). */
export function repeatReminder(name: string, n: number): string {
  return `${REPEAT_REMINDER_MARK} You have now made this same ${name} call ${n} times in a row and got the same result each time. Do not call it again the same way: try something different, or tell the user what is in the way.`;
}

/** The result of the call that was not run. */
export function repeatStopResult(name: string, n: number): string {
  return `${REPEAT_STOP_MARK} This would have been the ${n}th same ${name} call in a row with the same result, so it was not run and the run stopped. The user decides whether to go on.`;
}
