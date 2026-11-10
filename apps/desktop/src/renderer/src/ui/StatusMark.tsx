// Small status glyph for a session in the tree. Running states animate
// gently; waiting-for-you is the only colored one, so it stands out.
import type { SessionStatus } from '@spica/protocol';
import type { StatusIconName } from '@spica/brand';
import { SpicaStatusIcon } from '@spica/brand/react';

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

/** Each state's icon from the brand's status family; idle shows nothing. */
const ICON: Partial<Record<SessionStatus, StatusIconName>> = {
  thinking: 'running',
  tool: 'running',
  queued: 'queued',
  awaiting_confirm: 'waiting',
  awaiting_answer: 'question',
  error: 'error',
  interrupted: 'error',
  aborted: 'stopped',
  done: 'done',
};

/** `note`: said on hover and to screen readers instead of the state's name (a collapsed project's counts). */
export function StatusMark({ status, note }: { status: SessionStatus; note?: string }) {
  const name = ICON[status];
  if (!name) return <span className="status-mark" aria-hidden />;
  const said = note || STATUS_LABEL[status];
  return (
    <span className="status-mark" role="img" aria-label={said} title={said}>
      <SpicaStatusIcon name={name} size={12} />
    </span>
  );
}
