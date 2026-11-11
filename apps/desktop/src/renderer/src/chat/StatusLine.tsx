// The line under the latest answer while the agent works: mark animation +
// elapsed time for this run + what it is doing. After a run it shows
// "已完成 · 用时" briefly, then goes away.
import { useEffect, useState } from 'react';
import { MEMORY_TOOLS, type Transcript } from '../store/transcript';
import { SpicaMark } from '@spica/brand/react';
import { formatClock, formatDuration, toolLabel } from './format';

export const DONE_LINGER_MS = 1400;

export type MarkState = 'think' | 'busy' | 'tool' | 'await' | 'done';

function runningTool(t: Transcript): string | undefined {
  const last = t.items[t.items.length - 1];
  if (last?.kind === 'response') {
    for (let i = last.blocks.length - 1; i >= 0; i--) {
      const b = last.blocks[i];
      if (b?.type === 'tool' && (b.state === 'running' || b.state === 'pending')) return b.name;
    }
  }
  return t.run?.detail;
}

export function phaseOf(t: Transcript): { mark: MarkState; text: string } | null {
  const run = t.run;
  if (!run) return null;
  switch (run.status) {
    case 'queued':
      return { mark: 'await', text: run.queuePosition ? `排队中（前面 ${Math.max(0, run.queuePosition - 1)} 个）` : '排队中' };
    case 'tool': {
      const name = runningTool(t);
      return { mark: 'tool', text: name ? `正在${toolLabel(name)}` : '正在调用工具' };
    }
    case 'awaiting_confirm':
      return { mark: 'await', text: '等待确认' };
    case 'awaiting_answer':
      return { mark: 'await', text: '等待回答' };
    default: {
      const last = t.items[t.items.length - 1];
      const block = last?.kind === 'response' ? last.blocks[last.blocks.length - 1] : undefined;
      return block?.type === 'text' ? { mark: 'busy', text: '正在回复' } : { mark: 'think', text: '思考中' };
    }
  }
}

/**
 * The run is doing what the answer's last line already says, with the clock at its end: a tool
 * running (alone or in its group), or thinking shown as it streams. The status line stays away then.
 */
export function shownInAnswer(t: Transcript): boolean {
  if (!t.run) return false;
  const last = t.items[t.items.length - 1];
  if (last?.kind !== 'response') return false;
  const blocks = last.blocks;
  const end = blocks[blocks.length - 1];
  if (end?.type === 'thinking') return t.run.status === 'thinking';
  // remember / forget show nothing while they run (their line comes with the result): the status line says it.
  const grouped = (b: (typeof blocks)[number] | undefined) => b?.type === 'tool' && !MEMORY_TOOLS.has(b.name);
  if (!grouped(end)) return false;
  // The tools at the end of the answer, as one group.
  let i = blocks.length - 1;
  while (i > 0 && grouped(blocks[i - 1])) i--;
  return blocks.slice(i).some((b) => b.type === 'tool' && b.state === 'running');
}

export function StatusLine({ transcript }: { transcript: Transcript }) {
  const phase = shownInAnswer(transcript) ? null : phaseOf(transcript);
  const last = transcript.lastRun;
  const [now, setNow] = useState(() => Date.now());
  const active = Boolean(phase);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  // Re-render once the "done" line has been shown long enough, so it goes away.
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setNow(Date.now()), DONE_LINGER_MS + 50);
    return () => clearTimeout(t);
  }, [last]);
  const lingering = Boolean(last && last.reason !== 'aborted' && last.reason !== 'error' && now - last.endedAt < DONE_LINGER_MS);

  if (phase && transcript.run) {
    return (
      <div className="status-line" role="status" aria-live="polite">
        <SpicaMark size={18} state={phase.mark} />
        <span className="status-clock">{formatClock(now - transcript.run.startedAt)}</span>
        <span className="status-text">{phase.text}</span>
      </div>
    );
  }
  if (lingering && last) {
    return (
      <div className="status-line is-finished" role="status">
        <SpicaMark size={18} state="done" />
        <span className="status-text">已完成 · 用时 {formatDuration(last.durationMs)}</span>
      </div>
    );
  }
  return null;
}
