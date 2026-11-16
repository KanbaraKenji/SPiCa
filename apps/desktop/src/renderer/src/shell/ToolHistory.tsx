// 工具调用 (the details' group heading) opened where the preview goes: every call of the open conversation in order,
// the ones running with their ring, the others with how they ended and their time; a click opens one as the
// conversation's tool rows do (chat/CallDetail.tsx: the command in its box, the change in red and green, the output),
// plain text only.
import { useState } from 'react';
import type { Transcript } from '../store/transcript';
import { CallDetail } from '../chat/CallDetail';
import { toolIcon } from '../chat/Blocks';
import { SpicaStatusIcon } from '@spica/brand/react';
import { formatDuration } from '../chat/format';
import { Icon } from '../ui/Icon';
import { t } from '../../../shared/i18n';
import { useEscape } from '../ui/escape';
import { detailTools, isRunning, ToolListText, type ToolBlock } from './DetailPanel';

export interface ToolHistoryProps {
  transcript: Transcript;
  onClose(): void;
}

/** How a finished call ended, after its words: Failed in red, the other stops in words, else how long it took. */
function endOf(b: ToolBlock): React.ReactNode {
  if (b.state === 'running' || b.state === 'pending') return <span className="text-danger">{t('已中断')}</span>;
  if (b.state === 'error') return <span className="text-danger">Failed</span>;
  if (b.state === 'timeout') return t('已超时');
  if (b.state === 'unavailable') return t('已停用，未执行');
  if (b.state === 'repeated') return t('重复，未执行');
  return b.durationMs !== undefined ? formatDuration(b.durationMs) : '';
}

export function ToolHistory({ transcript, onClose }: ToolHistoryProps) {
  const live = Boolean(transcript.run);
  const done = detailTools(transcript);
  const [open, setOpen] = useState<string | null>(null);
  // a call opened is a layer of Esc (closed before anything under it)
  useEscape(open !== null, () => setOpen(null));
  return (
    <aside className="tool-history" aria-label={t('工具调用')}>
      <header className="panel-head tool-history-head">
        <span className="detail-heading">{t('工具调用')}</span>
        <span className="detail-count">{done.length}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭工具调用')} title={t('关闭')}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <ol className="tool-history-list">
        {done.map((b) => {
          const isOpen = open === b.callId;
          return (
            <li key={b.callId} className={isOpen ? 'tool-history-item is-open' : 'tool-history-item'}>
              <button type="button" className="tool-history-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.callId)}>
                <span className="detail-item-icon">
                  {isRunning(b, live) ? <SpicaStatusIcon name="running" size={14} title={t('进行中')} /> : b.state === 'running' || b.state === 'pending' ? <SpicaStatusIcon name="stopped" size={14} /> : toolIcon(b)}
                </span>
                <ToolListText t={b} card={transcript.fileCards?.[b.callId]} running={isRunning(b, live)} />
                <span className="detail-item-meta">{isRunning(b, live) ? '' : endOf(b)}</span>
              </button>
              {isOpen ? (
                <div className="tool-history-body">
                  <CallDetail block={b} card={transcript.fileCards?.[b.callId]} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
