// A sidebar row's one status place: what it shows, and which finished sub-tasks still count as news.
import type { SessionInfo, SessionStatus } from '@spica/protocol';
import { joinNotes } from '../ui/NewDot';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '空闲',
  queued: '排队中',
  thinking: '思考中',
  tool: '调用工具中',
  awaiting_confirm: '等待确认',
  awaiting_answer: '等待回答',
  done: '已完成',
  error: '出错',
  aborted: '已停止',
  interrupted: '已中断',
};

/**
 * What a row can show, most pressing first. Only one is drawn at a time:
 * waiting for you (yellow dot) > error, interrupted (red dot) > running (ring) >
 * news: mail, a report, a sub-task finished and not opened yet (blue dot) > queued > stopped.
 * Idle rows and finished ones already opened show nothing.
 */
export type SlotKind = 'waiting' | 'error' | 'running' | 'news' | 'queued' | 'stopped';
const ORDER: readonly SlotKind[] = ['waiting', 'error', 'running', 'news', 'queued', 'stopped'];

export interface Slot {
  kind: SlotKind;
  /** Said on hover and to screen readers. */
  text: string;
}

const DONE = STATUS_LABEL.done;

/** Everything one row has to say; `topSlot` picks the one that is drawn. */
export function slotsOf(s: SessionInfo, o: { note?: string | undefined; active: boolean; unseenDone: boolean }): Slot[] {
  const out: Slot[] = [];
  if (s.status === 'awaiting_answer' || s.status === 'awaiting_confirm') out.push({ kind: 'waiting', text: STATUS_LABEL[s.status] });
  if (s.status === 'error' || s.status === 'interrupted') out.push({ kind: 'error', text: STATUS_LABEL[s.status] });
  if (s.status === 'thinking' || s.status === 'tool') out.push({ kind: 'running', text: STATUS_LABEL[s.status] });
  if (o.note && !o.active) out.push({ kind: 'news', text: o.note });
  if (s.status === 'done' && !o.active && o.unseenDone) out.push({ kind: 'news', text: DONE });
  if (s.status === 'queued') out.push({ kind: 'queued', text: STATUS_LABEL.queued });
  if (s.status === 'aborted') out.push({ kind: 'stopped', text: STATUS_LABEL.aborted });
  return out;
}

export function topSlot(slots: readonly Slot[]): Slot | null {
  for (const k of ORDER) {
    const hit = slots.find((x) => x.kind === k);
    if (hit) return hit;
  }
  return null;
}

/** A collapsed row's hover text: counts over it and everything below it (only those not zero), then what is new. */
export function rollupText(slots: readonly Slot[]): string {
  const count = (k: SlotKind) => slots.filter((x) => x.kind === k).length;
  const done = slots.filter((x) => x.kind === 'news' && x.text === DONE).length;
  const parts: string[] = [];
  if (count('waiting')) parts.push(`${count('waiting')} 个待处理`);
  if (count('error')) parts.push(`${count('error')} 个出错`);
  if (count('running')) parts.push(`${count('running')} 个运行中`);
  if (done) parts.push(`${done} 个已完成`);
  if (count('queued')) parts.push(`${count('queued')} 个排队中`);
  if (count('stopped')) parts.push(`${count('stopped')} 个已停止`);
  return joinNotes([...parts, ...slots.filter((x) => x.kind === 'news' && x.text !== DONE).map((x) => x.text)]);
}

/** Finished sub-tasks nobody has opened since they finished. `seen` null: nothing recorded yet, so none. */
export function unseenDone(sessions: readonly SessionInfo[], seen: readonly string[] | null): Set<string> {
  if (!seen) return new Set();
  const known = new Set(seen);
  return new Set(sessions.filter((s) => s.status === 'done' && !known.has(s.id)).map((s) => s.id));
}

/**
 * The record of finished sub-tasks already opened, brought up to date; null when it is as it should be.
 * - Nothing recorded yet: everything finished so far counts as seen (no row lights up for old work).
 * - One that runs again or is gone leaves the record, so its next finish is news again.
 * - The one open now, when finished, joins it.
 */
export function nextDoneSeen(sessions: readonly SessionInfo[], seen: readonly string[] | null, openId: string | null): string[] | null {
  const done = sessions.filter((s) => s.status === 'done').map((s) => s.id);
  if (!seen) return done;
  const isDone = new Set(done);
  const next = seen.filter((id) => isDone.has(id));
  if (openId && isDone.has(openId) && !next.includes(openId)) next.push(openId);
  return next.length === seen.length && next.every((id, i) => id === seen[i]) ? null : next;
}
