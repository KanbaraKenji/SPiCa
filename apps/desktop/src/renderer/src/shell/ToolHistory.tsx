// 工具调用 X (the details' last row) opened where the preview goes: every finished call of the open conversation in
// order, with how it ended (as in the conversation's tool rows), its time, and a click to see its input and result.
// Input and result are plain text (React text nodes), as the monitor shows a line in full; the result as the
// conversation's tool rows show it (resultBody: without what only the model reads).
import { useState } from 'react';
import { resultBody, type Transcript } from '../store/transcript';
import { toolIcon } from '../chat/Blocks';
import { SpicaStatusIcon } from '@spica/brand/react';
import { formatDuration } from '../chat/format';
import { Icon } from '../ui/Icon';
import { useEscape } from '../ui/escape';
import { detailTools, isRunning, ToolListText, type ToolBlock } from './DetailPanel';

export interface ToolHistoryProps {
  transcript: Transcript;
  onClose(): void;
}

/** How a finished call ended, after its words: Failed in red, the other stops in words, else how long it took. */
function endOf(t: ToolBlock): React.ReactNode {
  if (t.state === 'running' || t.state === 'pending') return <span className="text-danger">已中断</span>;
  if (t.state === 'error') return <span className="text-danger">Failed</span>;
  if (t.state === 'timeout') return '已超时';
  if (t.state === 'unavailable') return '已停用，未执行';
  if (t.state === 'repeated') return '重复，未执行';
  return t.durationMs !== undefined ? formatDuration(t.durationMs) : '';
}

/** A call's input as text: a string as it is, anything else as indented JSON. */
export function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

export function ToolHistory({ transcript, onClose }: ToolHistoryProps) {
  const live = Boolean(transcript.run);
  const done = detailTools(transcript).filter((t) => !isRunning(t, live));
  const [open, setOpen] = useState<string | null>(null);
  // a call opened is a layer of Esc (closed before anything under it)
  useEscape(open !== null, () => setOpen(null));
  return (
    <aside className="tool-history" aria-label="工具调用">
      <header className="panel-head tool-history-head">
        <span className="detail-heading">工具调用</span>
        <span className="detail-count">{done.length}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭工具调用" title="关闭">
          <Icon name="close" size={14} />
        </button>
      </header>
      <ol className="tool-history-list">
        {done.map((t) => {
          const isOpen = open === t.callId;
          return (
            <li key={t.callId} className={isOpen ? 'tool-history-item is-open' : 'tool-history-item'}>
              <button type="button" className="tool-history-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.callId)}>
                <span className="detail-item-icon">{t.state === 'running' || t.state === 'pending' ? <SpicaStatusIcon name="stopped" size={14} /> : toolIcon(t)}</span>
                <ToolListText t={t} card={transcript.fileCards?.[t.callId]} />
                <span className="detail-item-meta">{endOf(t)}</span>
              </button>
              {isOpen ? (
                <div className="tool-history-body">
                  <span className="tool-history-label">输入</span>
                  <pre className="tool-history-text">{inputText(t.input)}</pre>
                  <span className="tool-history-label">结果</span>
                  <pre className="tool-history-text">{t.result !== undefined ? resultBody(t.result) : (t.preview ?? '—')}</pre>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
