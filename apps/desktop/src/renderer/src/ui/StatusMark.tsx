// Small status glyph for a session in the tree. Running states animate
// gently; waiting-for-you is the only colored one, so it stands out.
import type { SessionStatus } from '@spica/protocol';

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

export function StatusMark({ status }: { status: SessionStatus }) {
  const kind =
    status === 'thinking' || status === 'tool'
      ? 'run'
      : status === 'queued'
        ? 'queue'
        : status === 'awaiting_answer' || status === 'awaiting_confirm'
          ? 'wait'
          : status === 'error' || status === 'interrupted'
            ? 'error'
            : status === 'done'
              ? 'done'
              : 'none';
  if (kind === 'none') return <span className="status-mark" aria-hidden />;
  return (
    <span className={`status-mark status-${kind}`} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {kind === 'done' ? (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}
