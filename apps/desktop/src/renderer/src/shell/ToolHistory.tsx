// 工具调用 X (the details' last row) opened where the preview goes: every finished call of the open conversation in
// order, with how it ended (as in the conversation's tool rows), its time, and a click to see its input and result.
// Input and result are plain text (React text nodes), as the monitor shows a line in full.
import { useState } from 'react';
import type { Transcript } from '../store/transcript';
import { toolIcon } from '../chat/Blocks';
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
  const done = detailTools(transcript).filter((t) => !isRunning(t));
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
                <span className="detail-item-icon">{toolIcon(t)}</span>
                <ToolListText t={t} card={transcript.fileCards?.[t.callId]} />
                <span className="detail-item-meta">{endOf(t)}</span>
              </button>
              {isOpen ? (
                <div className="tool-history-body">
                  <span className="tool-history-label">输入</span>
                  <pre className="tool-history-text">{inputText(t.input)}</pre>
                  <span className="tool-history-label">结果</span>
                  <pre className="tool-history-text">{t.result ?? t.preview ?? '—'}</pre>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
